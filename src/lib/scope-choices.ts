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
/** A vendor cannot make this process read more than this much of one answer, or page through more than MAX_PAGES. */
const MAX_BODY_BYTES = 2_000_000;
const MAX_PAGES = 50;

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); throw new Error('too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
  try { return JSON.parse(await readCapped(res, MAX_BODY_BYTES)); } catch { throw new ScopeLookupError(`${vendor} sent a list this CLI could not read.`, 'unreachable'); }
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function atlassianHeaders(fields: Record<string, string>): Record<string, string> {
  const token = fields['token'];
  const email = fields['email'];
  if (!token || !email) throw new ScopeLookupError('The Atlassian connection has no email saved, so its list cannot be read. Reconnect with: align connect <jira|confluence>', 'unsupported');
  return { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, Accept: 'application/json' };
}

export interface Listed<T> {
  items: T[];
  /** True when the vendor had more than was read. A key missing from a truncated list is NOT known to be invisible: look it up directly. */
  truncated: boolean;
}

export async function listJiraProjects(fields: Record<string, string>, f: FetchLike, o: { max?: number } = {}): Promise<Listed<{ key: string; name: string }>> {
  const max = o.max ?? MAX_LISTED;
  const host = hostOf('Jira', fields['domain']);
  const headers = atlassianHeaders(fields);
  const items: Array<{ key: string; name: string }> = [];
  let truncated = false;
  for (let startAt = 0; items.length < max;) {
    const page = asRecord(await get('Jira', `https://${host}/rest/api/3/project/search?maxResults=100&startAt=${startAt}`, headers, f));
    const values = Array.isArray(page['values']) ? page['values'] : [];
    for (const v of values) {
      const key = text(asRecord(v)['key']);
      if (key !== undefined) items.push({ key, name: text(asRecord(v)['name']) ?? key });
    }
    if (page['isLast'] !== false || values.length === 0) break;
    startAt += values.length;
    if (items.length >= max) truncated = true;
  }
  return { items, truncated };
}

export async function listConfluenceSpaces(fields: Record<string, string>, f: FetchLike, o: { max?: number } = {}): Promise<Listed<{ key: string; name: string }>> {
  const max = o.max ?? MAX_LISTED;
  const host = hostOf('Confluence', fields['domain']);
  const headers = atlassianHeaders(fields);
  const base = `https://${host}`;
  const items: Array<{ key: string; name: string }> = [];
  let truncated = false;
  let next: string | undefined = '/wiki/api/v2/spaces?limit=250';
  for (let pages = 0; next !== undefined; pages++) {
    if (pages >= MAX_PAGES) { truncated = true; break; }
    const page = asRecord(await get('Confluence', `${base}${next}`, headers, f));
    for (const v of Array.isArray(page['results']) ? page['results'] : []) {
      const key = text(asRecord(v)['key']);
      if (key !== undefined) items.push({ key, name: text(asRecord(v)['name']) ?? key });
    }
    // Only a path on the same site is followed: an absolute link elsewhere would carry the credential to another host.
    const link = text(asRecord(page['_links'])['next']);
    next = link !== undefined && link.startsWith('/') && !link.startsWith('//') ? link : undefined;
    if (next !== undefined && items.length >= max) { truncated = true; break; }
  }
  return { items, truncated };
}

function linearHeaders(fields: Record<string, string>): Record<string, string> {
  const token = fields['token'];
  if (!token) throw new ScopeLookupError('The Linear connection has no token saved. Reconnect: align connect linear', 'unsupported');
  // A personal API key goes bare and an OAuth token as Bearer; Linear refuses the other way round with a 400 (connector-core).
  return { Authorization: token.startsWith('lin_api_') ? token : `Bearer ${token}`, 'Content-Type': 'application/json' };
}

type LinearTeam = { id: string; key: string; name: string };
const toTeams = (nodes: unknown): LinearTeam[] => {
  const out: LinearTeam[] = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const id = text(asRecord(n)['id']);
    const key = text(asRecord(n)['key']);
    if (id !== undefined && key !== undefined) out.push({ id, key, name: text(asRecord(n)['name']) ?? key });
  }
  return out;
};

export async function listLinearTeams(fields: Record<string, string>, f: FetchLike): Promise<Listed<LinearTeam>> {
  const body = await get('Linear', 'https://api.linear.app/graphql', linearHeaders(fields), f, { method: 'POST', body: JSON.stringify({ query: 'query { teams(first: 100) { nodes { id key name } pageInfo { hasNextPage } } }' }) });
  const teams = asRecord(asRecord(asRecord(body)['data'])['teams']);
  if (!Array.isArray(teams['nodes'])) throw new ScopeLookupError('Linear did not return a team list.', 'unreachable');
  return { items: toTeams(teams['nodes']), truncated: asRecord(teams['pageInfo'])['hasNextPage'] === true };
}

/** One team by key, for a key a truncated list did not show. */
export async function findLinearTeam(fields: Record<string, string>, key: string, f: FetchLike): Promise<LinearTeam | undefined> {
  // The key travels as a GraphQL variable, never spliced into the query text.
  const query = 'query($key: String!) { teams(first: 1, filter: { key: { eq: $key } }) { nodes { id key name } } }';
  const body = await get('Linear', 'https://api.linear.app/graphql', linearHeaders(fields), f, { method: 'POST', body: JSON.stringify({ query, variables: { key } }) });
  return toTeams(asRecord(asRecord(asRecord(body)['data'])['teams'])['nodes'])[0];
}

/** Is this one project visible? Asked directly, for a key a truncated list did not show. A refused token is an error, not "no". */
export async function findJiraProject(fields: Record<string, string>, key: string, f: FetchLike): Promise<boolean> {
  const host = hostOf('Jira', fields['domain']);
  const headers = atlassianHeaders(fields);
  const code = await status(`https://${host}/rest/api/3/project/${encodeURIComponent(key)}`, headers, f);
  if (code === 200) return true;
  if (code === 404) return false;
  if (code === 401 || code === 403) throw new ScopeLookupError('Jira refused the saved token. Reconnect: align connect jira', 'auth');
  throw new ScopeLookupError(`Could not check a Jira project (Jira answered ${code ?? 'nothing'}).`, 'unreachable');
}

export async function findConfluenceSpace(fields: Record<string, string>, key: string, f: FetchLike): Promise<boolean> {
  const host = hostOf('Confluence', fields['domain']);
  const page = asRecord(await get('Confluence', `https://${host}/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}&limit=1`, atlassianHeaders(fields), f));
  return (Array.isArray(page['results']) ? page['results'] : []).some((v) => asRecord(v)['key'] === key);
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
  if (!REPO.test(repo) || repo.split('/').some((seg) => /^\.+$/.test(seg))) return 'unknown';
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
