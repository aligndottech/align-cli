import { atlassianHeaders, findLinearTeam, linearHeaders, ScopeLookupError } from '../scope-choices.js';

/**
 * The write half of `align backlog`: create ONE issue in the tracker the person named, with the credential they
 * hold. Every function takes the `fetch` to use, so a test runs against scripted responses and nothing here
 * touches a network it was not handed. Redirects are never followed with the credential, a host never comes from
 * a flag, and an error says what failed and never carries the token or a response body.
 */
export type TrackerId = 'linear' | 'github' | 'jira';
export const TRACKERS: readonly TrackerId[] = ['linear', 'github', 'jira'];
export const TRACKER_LABEL: Record<TrackerId, string> = { linear: 'Linear', github: 'GitHub Issues', jira: 'Jira' };

export interface CreatedIssue { key: string; url: string }
export interface NewIssue { title: string; body: string }

/** The credential is real but cannot write. Distinct from "unreachable": the fix is a different key, not a retry. */
export class CannotCreateError extends Error {
  constructor(tracker: TrackerId) {
    super(`${TRACKER_LABEL[tracker]} refused to create an issue (401/403): this credential can read but not write, is not valid, or is being rate limited. Pass --token with one that can create issues (an unscoped personal API key does), or wait and run again.`);
    this.name = 'CannotCreateError';
  }
}

/** The request may have reached the tracker even though no answer came back, so the issue may exist. */
export class MaybeCreatedError extends Error {
  constructor(tracker: TrackerId) {
    super(`No answer from ${TRACKER_LABEL[tracker]}: the issue may or may not have been created. Check the tracker before running again.`);
    this.name = 'MaybeCreatedError';
  }
}

const TIMEOUT_MS = 15_000;

async function post(tracker: TrackerId, url: string, headers: Record<string, string>, body: unknown, f: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new MaybeCreatedError(tracker);
  }
  if (res.status === 401 || res.status === 403) throw new CannotCreateError(tracker);
  if (!res.ok) throw new Error(`${TRACKER_LABEL[tracker]} answered ${res.status} when creating the issue.`);
  try { return await res.json(); } catch { throw new Error(`${TRACKER_LABEL[tracker]} sent an answer this CLI could not read.`); }
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The workspace's url key (the `acme` in linear.app/acme), so one team key in two workspaces is two destinations. A read, never a write. */
export async function linearWorkspace(fields: Record<string, string>, f: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await f('https://api.linear.app/graphql', { method: 'POST', headers: linearHeaders(fields), body: JSON.stringify({ query: 'query { organization { urlKey } }' }), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof ScopeLookupError) throw new Error(e.message);
    throw new Error('Could not reach Linear to read which workspace this key belongs to, so nothing was created.');
  }
  const key = res.ok ? str(rec(rec(rec(await res.json().catch(() => ({})))['data'])['organization'])['urlKey']) : undefined;
  if (key === undefined) throw new Error(`Linear would not say which workspace this key belongs to (answered ${res.status}), so nothing was created.`);
  return key;
}

const LINEAR_CREATE = 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }';

/** Resolve a team key to the id issueCreate wants. Undefined when the token cannot see that team. */
export async function resolveLinearTeamId(fields: Record<string, string>, key: string, f: typeof fetch): Promise<string | undefined> {
  try {
    return (await findLinearTeam(fields, key, f))?.id;
  } catch (e) {
    if (e instanceof ScopeLookupError) throw new Error(e.message);
    throw e;
  }
}

export async function createLinearIssue(fields: Record<string, string>, teamId: string, issue: NewIssue, f: typeof fetch): Promise<CreatedIssue> {
  const out = rec(await post('linear', 'https://api.linear.app/graphql', linearHeaders(fields), { query: LINEAR_CREATE, variables: { input: { teamId, title: issue.title, description: issue.body } } }, f));
  if (Array.isArray(out['errors']) && out['errors'].length > 0) {
    const first = str(rec((out['errors'] as unknown[])[0])['message']);
    throw new Error(`Linear refused the issue${first ? `: ${first}` : '.'}`);
  }
  const made = rec(rec(rec(out['data'])['issueCreate'])['issue']);
  const key = str(made['identifier']); const url = str(made['url']);
  if (key === undefined || url === undefined) throw new Error('Linear did not confirm the issue was created.');
  return { key, url };
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const isRepo = (s: string): boolean => REPO.test(s) && !s.split('/').some((seg) => /^\.+$/.test(seg));

export async function createGithubIssue(fields: Record<string, string>, repo: string, issue: NewIssue, f: typeof fetch): Promise<CreatedIssue> {
  if (!isRepo(repo)) throw new Error(`"${repo}" is not an owner/repo name.`);
  const token = fields['token'];
  if (!token) throw new Error('The GitHub connection has no token saved. Reconnect: align connect github');
  const out = rec(await post('github', `https://api.github.com/repos/${repo}/issues`, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'align-cli' }, { title: issue.title, body: issue.body }, f));
  const num = out['number']; const url = str(out['html_url']);
  if (typeof num !== 'number' || url === undefined) throw new Error('GitHub did not confirm the issue was created.');
  return { key: `${repo}#${num}`, url };
}

const JIRA_PROJECT = /^[A-Za-z][A-Za-z0-9_]{1,19}$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isJiraProject = (s: string): boolean => JIRA_PROJECT.test(s);

/** Jira's v3 API wants Atlassian Document Format: one paragraph per blank-line-separated block. */
function adf(text: string): unknown {
  return { type: 'doc', version: 1, content: text.split(/\n{2,}/).filter((p) => p.trim() !== '').map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) };
}

export async function createJiraIssue(fields: Record<string, string>, project: string, issue: NewIssue, f: typeof fetch): Promise<CreatedIssue> {
  const domain = fields['domain'];
  if (domain === undefined || !HOSTNAME.test(domain)) throw new Error('The Jira connection has no usable site saved. Reconnect: align connect jira');
  if (!isJiraProject(project)) throw new Error(`"${project}" is not a Jira project key.`);
  let headers: Record<string, string>;
  try { headers = atlassianHeaders(fields); } catch (e) { throw new Error((e as Error).message); }
  const out = rec(await post('jira', `https://${domain}/rest/api/3/issue`, headers, { fields: { project: { key: project }, summary: issue.title, description: adf(issue.body), issuetype: { name: 'Task' } } }, f));
  const key = str(out['key']);
  if (key === undefined) throw new Error('Jira did not confirm the issue was created.');
  return { key, url: `https://${domain}/browse/${key}` };
}
