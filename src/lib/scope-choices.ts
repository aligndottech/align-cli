/**
 * L4: what a saved token can SEE, to offer as a choice or to check one against: Jira projects, Confluence spaces, Linear
 * teams, whether a GitHub repo or GitLab project is visible at all.
 *
 * These run inside the CLI process with the token the person already saved. The token is sent only to the vendor's own host,
 * built from the connector's stored fields and checked to be a plain hostname first (the SDK's addendum 1, applied here:
 * a host never comes from a flag, a tool argument or a URL). Redirects are never followed with the credential. Results are
 * keys and names. An error says what failed and never carries the token or a response body.
 *
 * Every function takes the `fetch` to use, so a test runs against scripted responses and nothing here touches a network
 * it was not handed.
 */
export type FetchLike = typeof fetch;
type Init = NonNullable<Parameters<typeof fetch>[1]>;

export class ScopeLookupError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'unreachable' | 'unsupported') {
    super(message);
    this.name = 'ScopeLookupError';
  }
}

export type Visibility = 'visible' | 'invisible' | 'unknown';

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TIMEOUT_MS = 10_000;
const MAX_LISTED = 1000;

function hostOf(vendor: string, domain: string | undefined): string {
  if (domain === undefined || !HOSTNAME.test(domain)) {
    throw new ScopeLookupError(`The ${vendor} connection has no usable site saved, so its list cannot be read. Reconnect: align connect ${vendor.toLowerCase()}`, 'unsupported');
  }
  return domain;
}

async function get(vendor: string, url: string, headers: Record<string, string>, f: FetchLike, init: Init = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ScopeLookupError(`Could not reach ${vendor} to read the list.`, 'unreachable');
  }
  if (res.status === 401 || res.status === 403) {
    throw new ScopeLookupError(`${vendor} refused the saved token. Reconnect: align connect ${vendor.toLowerCase()}`, 'auth');
  }
  if (!res.ok) throw new ScopeLookupError(`${vendor} answered ${res.status} when reading the list.`, 'unreachable');
  try { return await res.json(); } catch { throw new ScopeLookupError(`${vendor} sent a list this CLI could not read.`, 'unreachable'); }
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function atlassianHeaders(fields: Record<string, string>): Record<string, string> {
  const token = fields['token'];
  const email = fields['email'];
  if (!token || !email) throw new ScopeLookupError('The Atlassian connection has no email saved, so its list cannot be read. Reconnect with: align connect <jira|confluence>', 'unsupported');
  return { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, Accept: 'application/json' };
}

export async function listJiraProjects(fields: Record<string, string>, f: FetchLike): Promise<Array<{ key: string; name: string }>> {
  const host = hostOf('Jira', fields['domain']);
  const headers = atlassianHeaders(fields);
  const out: Array<{ key: string; name: string }> = [];
  for (let startAt = 0; out.length < MAX_LISTED;) {
    const page = asRecord(await get('Jira', `https://${host}/rest/api/3/project/search?maxResults=100&startAt=${startAt}`, headers, f));
    const values = Array.isArray(page['values']) ? page['values'] : [];
    for (const v of values) {
      const key = text(asRecord(v)['key']);
      if (key !== undefined) out.push({ key, name: text(asRecord(v)['name']) ?? key });
    }
    if (page['isLast'] !== false || values.length === 0) break;
    startAt += values.length;
  }
  return out;
}

export async function listConfluenceSpaces(fields: Record<string, string>, f: FetchLike): Promise<Array<{ key: string; name: string }>> {
  const host = hostOf('Confluence', fields['domain']);
  const headers = atlassianHeaders(fields);
  const base = `https://${host}`;
  const out: Array<{ key: string; name: string }> = [];
  let next: string | undefined = '/wiki/api/v2/spaces?limit=250';
  while (next !== undefined && out.length < MAX_LISTED) {
    const page = asRecord(await get('Confluence', `${base}${next}`, headers, f));
    for (const v of Array.isArray(page['results']) ? page['results'] : []) {
      const key = text(asRecord(v)['key']);
      if (key !== undefined) out.push({ key, name: text(asRecord(v)['name']) ?? key });
    }
    // Only a path on the same site is followed: an absolute link elsewhere would carry the credential to another host.
    const link = text(asRecord(page['_links'])['next']);
    next = link !== undefined && link.startsWith('/') && !link.startsWith('//') ? link : undefined;
  }
  return out;
}

export async function listLinearTeams(fields: Record<string, string>, f: FetchLike): Promise<Array<{ id: string; key: string; name: string }>> {
  const token = fields['token'];
  if (!token) throw new ScopeLookupError('The Linear connection has no token saved. Reconnect: align connect linear', 'unsupported');
  // A personal API key goes bare and an OAuth token as Bearer; Linear refuses the other way round with a 400 (connector-core).
  const headers = { Authorization: token.startsWith('lin_api_') ? token : `Bearer ${token}`, 'Content-Type': 'application/json' };
  const body = await get('Linear', 'https://api.linear.app/graphql', headers, f, { method: 'POST', body: JSON.stringify({ query: 'query { teams(first: 100) { nodes { id key name } } }' }) });
  const nodes = asRecord(asRecord(asRecord(body)['data'])['teams'])['nodes'];
  if (!Array.isArray(nodes)) throw new ScopeLookupError('Linear did not return a team list.', 'unreachable');
  const out: Array<{ id: string; key: string; name: string }> = [];
  for (const n of nodes) {
    const id = text(asRecord(n)['id']);
    const key = text(asRecord(n)['key']);
    if (id !== undefined && key !== undefined) out.push({ id, key, name: text(asRecord(n)['name']) ?? key });
  }
  return out;
}

async function status(url: string, headers: Record<string, string>, f: FetchLike): Promise<number | undefined> {
  try {
    return (await f(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })).status;
  } catch {
    return undefined;
  }
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Can this token search `repo:o/r`? P0 measured GitHub answering 422 "cannot be searched" for a private repo the token has no access to. */
export async function githubRepoVisibility(token: string, repo: string, f: FetchLike): Promise<Visibility> {
  if (!REPO.test(repo)) return 'unknown';
  const code = await status(
    `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${repo}`)}&per_page=1`,
    { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'align-cli' },
    f,
  );
  return code === 200 ? 'visible' : code === 422 ? 'invisible' : 'unknown';
}

export async function gitlabProjectVisibility(fields: Record<string, string>, project: string, f: FetchLike): Promise<Visibility> {
  const token = fields['token'];
  const domain = fields['domain'] || 'gitlab.com';
  if (!token || !HOSTNAME.test(domain)) return 'unknown';
  const code = await status(`https://${domain}/api/v4/projects/${encodeURIComponent(project)}`, { Authorization: `Bearer ${token}` }, f);
  return code === 200 ? 'visible' : code === 404 ? 'invisible' : 'unknown';
}
