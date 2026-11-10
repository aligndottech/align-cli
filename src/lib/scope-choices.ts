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
import { buildJiraJql } from '@aligndottech/connector-core';

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

/** The top-level pages of the given Confluence spaces, as `KEY: title`, for the picker that narrows a space to some pages. */
export async function listConfluenceTopLevelPages(fields: Record<string, string>, spaceKeys: string[], f: FetchLike, o: { max?: number } = {}): Promise<Listed<{ id: string; name: string }>> {
  const max = o.max ?? 100;
  const host = hostOf('Confluence', fields['domain']);
  const headers = atlassianHeaders(fields);
  const found = asRecord(await get('Confluence', `https://${host}/wiki/api/v2/spaces?keys=${spaceKeys.map(encodeURIComponent).join(',')}&limit=250`, headers, f));
  const items: Array<{ id: string; name: string }> = [];
  let truncated = false;
  for (const sp of Array.isArray(found['results']) ? found['results'] : []) {
    const id = asRecord(sp)['id'];
    const key = text(asRecord(sp)['key']);
    if ((typeof id !== 'string' && typeof id !== 'number') || !DIGITS.test(String(id)) || key === undefined) continue;
    const page = asRecord(await get('Confluence', `https://${host}/wiki/api/v2/spaces/${String(id)}/pages?depth=root&limit=${max}`, headers, f));
    for (const v of Array.isArray(page['results']) ? page['results'] : []) {
      const pid = asRecord(v)['id'];
      const title = text(asRecord(v)['title']);
      if ((typeof pid === 'string' || typeof pid === 'number') && DIGITS.test(String(pid)) && title !== undefined) items.push({ id: String(pid), name: `${key}: ${title}` });
    }
    if (text(asRecord(page['_links'])['next']) !== undefined) truncated = true;
  }
  return { items: items.slice(0, max), truncated: truncated || items.length > max };
}

/** One Confluence page by id: its title, or undefined when the token cannot read it. A refused token is an error, not "no". */
export async function findConfluencePage(fields: Record<string, string>, id: string, f: FetchLike): Promise<{ title: string } | undefined> {
  if (!DIGITS.test(id)) return undefined;
  const host = hostOf('Confluence', fields['domain']);
  const headers = atlassianHeaders(fields);
  let res: Response;
  try {
    res = await f(`https://${host}/wiki/api/v2/pages/${id}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ScopeLookupError('Could not reach Confluence to check a page.', 'unreachable');
  }
  if (res.status === 404) return undefined;
  if (res.status === 401 || res.status === 403) throw new ScopeLookupError('Confluence refused the saved token. Reconnect: align connect confluence', 'auth');
  if (!res.ok) throw new ScopeLookupError(`Confluence answered ${res.status} when checking a page.`, 'unreachable');
  try { return { title: text(asRecord(JSON.parse(await readCapped(res, MAX_BODY_BYTES)))['title']) ?? id }; } catch { return { title: id }; }
}

function notionHeaders(fields: Record<string, string>): Record<string, string> {
  const token = fields['token'];
  if (!token) throw new ScopeLookupError('The Notion connection has no token saved. Reconnect: align connect notion', 'unsupported');
  return { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
}

/** A page's title is its one "title" property; a database's is its own `title`. Untitled ones are called so. */
function notionTitle(v: unknown): string {
  const r = asRecord(v);
  const plain = (rich: unknown): string => (Array.isArray(rich) ? rich.map((t) => text(asRecord(t)['plain_text']) ?? '').join('') : '').trim();
  const direct = plain(r['title']);
  if (direct !== '') return direct;
  for (const prop of Object.values(asRecord(r['properties']))) {
    if (asRecord(prop)['type'] === 'title') { const t = plain(asRecord(prop)['title']); if (t !== '') return t; }
  }
  return 'Untitled';
}

/** The pages and databases the Notion integration can see, newest edit first: titles and ids only. At most two pages of 100 are read. */
export async function listNotionPages(fields: Record<string, string>, f: FetchLike, o: { max?: number } = {}): Promise<Listed<{ id: string; name: string; kind: 'page' | 'database' }>> {
  const max = o.max ?? 200;
  const headers = notionHeaders(fields);
  const items: Array<{ id: string; name: string; kind: 'page' | 'database' }> = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let pages = 0; ; pages++) {
    if (pages >= 2) { truncated = true; break; }
    const body = asRecord(await get('Notion', 'https://api.notion.com/v1/search', headers, f, { method: 'POST', body: JSON.stringify({ page_size: 100, sort: { direction: 'descending', timestamp: 'last_edited_time' }, ...(cursor !== undefined ? { start_cursor: cursor } : {}) }) }));
    for (const v of Array.isArray(body['results']) ? body['results'] : []) {
      const id = text(asRecord(v)['id']);
      const kind = asRecord(v)['object'];
      if (id !== undefined && (kind === 'page' || kind === 'database')) items.push({ id, name: notionTitle(v), kind });
    }
    cursor = text(body['next_cursor']);
    if (body['has_more'] !== true || cursor === undefined) break;
  }
  return { items: items.slice(0, max), truncated: truncated || items.length > max };
}

/** One page or database by id, for an id a truncated list did not show. Its title, or undefined when the token cannot see it. */
export async function findNotionPage(fields: Record<string, string>, id: string, f: FetchLike): Promise<{ name: string } | undefined> {
  const headers = notionHeaders(fields);
  for (const kind of ['pages', 'databases']) {
    let res: Response;
    try {
      res = await f(`https://api.notion.com/v1/${kind}/${encodeURIComponent(id)}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ScopeLookupError('Could not reach Notion to check a page.', 'unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new ScopeLookupError('Notion refused the saved token. Reconnect: align connect notion', 'auth');
    if (res.ok) { try { return { name: notionTitle(JSON.parse(await readCapped(res, MAX_BODY_BYTES))) }; } catch { return { name: 'Untitled' }; } }
    if (res.status !== 404 && res.status !== 400) throw new ScopeLookupError(`Notion answered ${res.status} when checking a page.`, 'unreachable');
  }
  return undefined;
}

const DIGITS = /^\d{1,12}$/;

/**
 * The boards of one Jira project (Jira Software's Agile REST: GET /rest/agile/1.0/board?projectKeyOrId=KEY, paged by
 * startAt/maxResults/isLast, https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/). A site without
 * Jira Software answers 404 here: that is "no boards", and the person can still read the whole project or give --jql.
 */
export async function listJiraBoards(fields: Record<string, string>, projectKey: string, f: FetchLike, o: { max?: number } = {}): Promise<Listed<{ id: string; name: string }>> {
  const max = o.max ?? MAX_LISTED;
  const host = hostOf('Jira', fields['domain']);
  const headers = atlassianHeaders(fields);
  const items: Array<{ id: string; name: string }> = [];
  let truncated = false;
  for (let startAt = 0, pages = 0; items.length < max; pages++) {
    if (pages >= MAX_PAGES) { truncated = true; break; }
    let page: Record<string, unknown>;
    try {
      page = asRecord(await get('Jira', `https://${host}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&startAt=${startAt}&maxResults=50`, headers, f));
    } catch (e) {
      if (e instanceof ScopeLookupError && e.message.includes('answered 404')) return { items: [], truncated: false };
      throw e;
    }
    const values = Array.isArray(page['values']) ? page['values'] : [];
    for (const v of values) {
      const id = asRecord(v)['id'];
      const name = text(asRecord(v)['name']);
      if ((typeof id === 'number' || typeof id === 'string') && DIGITS.test(String(id)) && name !== undefined) items.push({ id: String(id), name });
    }
    if (page['isLast'] !== false || values.length === 0) break;
    startAt += values.length;
    if (items.length >= max) truncated = true;
  }
  return { items, truncated };
}

/** A board's saved filter JQL: its configuration names the filter, and the filter holds the JQL. The filter id must be digits before it enters a URL. */
export async function jiraBoardFilterJql(fields: Record<string, string>, boardId: string, f: FetchLike): Promise<string> {
  if (!DIGITS.test(boardId)) throw new ScopeLookupError('A Jira board id is digits.', 'unsupported');
  const host = hostOf('Jira', fields['domain']);
  const headers = atlassianHeaders(fields);
  const config = asRecord(await get('Jira', `https://${host}/rest/agile/1.0/board/${boardId}/configuration`, headers, f));
  const filterId = asRecord(config['filter'])['id'];
  if ((typeof filterId !== 'string' && typeof filterId !== 'number') || !DIGITS.test(String(filterId))) {
    throw new ScopeLookupError('That Jira board has no filter Align can read.', 'unsupported');
  }
  const jql = text(asRecord(await get('Jira', `https://${host}/rest/api/3/filter/${String(filterId)}`, headers, f))['jql']);
  if (jql === undefined) throw new ScopeLookupError('That Jira board has no filter Align can read.', 'unsupported');
  return jql;
}

/**
 * Does Jira accept this fragment inside these projects? One search for one issue. The JQL is built by connector-core's
 * buildJiraJql, the same function the read uses, so this CLI never writes JQL itself. 400 is invalid; 401/403 is the token.
 */
export async function checkJiraJql(fields: Record<string, string>, projects: string[], jql: string, f: FetchLike): Promise<'ok' | 'invalid'> {
  const host = hostOf('Jira', fields['domain']);
  const headers = { ...atlassianHeaders(fields), 'Content-Type': 'application/json' };
  let query: string;
  try { query = buildJiraJql({ projects, jql } as Parameters<typeof buildJiraJql>[0]); } catch { return 'invalid'; }
  let res: Response;
  try {
    res = await f(`https://${host}/rest/api/3/search/jql`, { method: 'POST', headers, body: JSON.stringify({ jql: query, maxResults: 1, fields: ['key'] }), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ScopeLookupError('Could not reach Jira to check the filter.', 'unreachable');
  }
  if (res.status === 401 || res.status === 403) throw new ScopeLookupError('Jira refused the saved token. Reconnect: align connect jira', 'auth');
  if (res.status === 400) return 'invalid';
  if (!res.ok) throw new ScopeLookupError(`Jira answered ${res.status} when checking the filter.`, 'unreachable');
  return 'ok';
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

/** Is `o/r` public? Asked WITHOUT the token: a fine-grained token can fail a search on a repo anyone can read. */
export async function githubRepoIsPublic(repo: string, f: FetchLike): Promise<boolean> {
  if (!REPO.test(repo) || repo.split('/').some((seg) => /^\.+$/.test(seg))) return false;
  try {
    const res = await f(`https://api.github.com/repos/${repo}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'align-cli' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.status === 200 && asRecord(await res.json())['private'] === false;
  } catch {
    return false;
  }
}

export async function gitlabProjectVisibility(fields: Record<string, string>, project: string, f: FetchLike): Promise<Visibility> {
  const token = fields['token'];
  const domain = fields['domain'] || 'gitlab.com';
  if (!token || !HOSTNAME.test(domain)) return 'unknown';
  const code = await status(`https://${domain}/api/v4/projects/${encodeURIComponent(project)}`, { Authorization: `Bearer ${token}` }, f);
  return code === 200 ? 'visible' : code === 404 ? 'invisible' : 'unknown';
}

/** One Linear team's projects. The team id travels as a GraphQL variable, never spliced into the query text. */
export async function listLinearProjects(fields: Record<string, string>, teamId: string, f: FetchLike): Promise<Listed<{ id: string; name: string }>> {
  const query = 'query($id: String!) { team(id: $id) { projects(first: 100) { nodes { id name } pageInfo { hasNextPage } } } }';
  const body = await get('Linear', 'https://api.linear.app/graphql', linearHeaders(fields), f, { method: 'POST', body: JSON.stringify({ query, variables: { id: teamId } }) });
  const projects = asRecord(asRecord(asRecord(asRecord(body)['data'])['team'])['projects']);
  if (!Array.isArray(projects['nodes'])) throw new ScopeLookupError('Linear did not return a project list.', 'unreachable');
  const items: Array<{ id: string; name: string }> = [];
  for (const n of projects['nodes']) {
    const id = text(asRecord(n)['id']);
    const name = text(asRecord(n)['name']);
    if (id !== undefined && name !== undefined) items.push({ id, name });
  }
  return { items, truncated: asRecord(projects['pageInfo'])['hasNextPage'] === true };
}

/**
 * One cheap call that says whether a vendor accepts a pasted token, before it is saved for a background read:
 * Atlassian /myself, Linear `viewer`, Slack auth.test, Notion /users/me. 'refused' only on a clear no (401/403, or
 * Slack's invalid_auth); anything that could not be checked is 'unknown', and the read itself will say.
 */
export async function proveToken(source: string, fields: Record<string, string>, f: FetchLike): Promise<'ok' | 'refused' | 'unknown'> {
  try {
    let res: Response;
    /** Request options for one identity call: the vendor's auth headers, no redirects, and a timeout. */
    const init = (headers: Record<string, string>, extra: Init = {}): Init => ({ ...extra, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    switch (source) {
      case 'jira':
      case 'confluence':
        res = await f(`https://${hostOf(source === 'jira' ? 'Jira' : 'Confluence', fields['domain'])}/rest/api/3/myself`, init(atlassianHeaders(fields)));
        break;
      case 'linear':
        res = await f('https://api.linear.app/graphql', init(linearHeaders(fields), { method: 'POST', body: JSON.stringify({ query: 'query { viewer { id } }' }) }));
        break;
      case 'slack': {
        res = await f('https://slack.com/api/auth.test', init({ Authorization: `Bearer ${fields['token'] ?? ''}` }, { method: 'POST' }));
        if (!res.ok) return res.status === 401 || res.status === 403 ? 'refused' : 'unknown';
        const body = asRecord(JSON.parse(await readCapped(res, MAX_BODY_BYTES)));
        return body['ok'] === true ? 'ok' : /invalid_auth|not_authed|token_revoked|account_inactive/.test(String(body['error'])) ? 'refused' : 'unknown';
      }
      case 'notion':
        res = await f('https://api.notion.com/v1/users/me', init({ Authorization: `Bearer ${fields['token'] ?? ''}`, 'Notion-Version': '2022-06-28' }));
        break;
      default:
        return 'unknown';
    }
    if (res.status === 401 || res.status === 403) return 'refused';
    return res.ok ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Does the installed connector-core apply a narrowing? An older one accepts the option and ignores it, which would read the
 * whole project or team. Asked of the builder itself, not of a version number.
 */
export function connectorCoreNarrows(): boolean {
  try {
    return buildJiraJql({ projects: ['P'], jql: 'x = 1' } as Parameters<typeof buildJiraJql>[0]).includes('AND (x = 1)');
  } catch {
    return false;
  }
}
