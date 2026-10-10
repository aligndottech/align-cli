/**
 * L4: what a source's scope is made of - the non-secret values a person can name (a repo, project keys, team keys, a
 * GitLab project, space keys), how each is checked, the canonical key it is stored under in `source_sync`, and the
 * words that describe it. Pure: no config, no database, no network. scope.ts decides which scope is in force; this
 * file only says what a valid one looks like.
 *
 * A refused value is never printed back. A scope value is typed into a flag or passed by an agent, and a token
 * pasted into the wrong field must not ride along into an error transcript.
 */

/** The sources that can read a NAMED team scope. Everything else reads a fixed scope (FIXED_SCOPES). */
export const SCOPED_SOURCES = ['github', 'jira', 'linear', 'gitlab', 'confluence'] as const;
export type ScopedSource = (typeof SCOPED_SOURCES)[number];

/** The option each fetcher takes for a team scope (connector-core 0.10.0). GitHub's is `repo` + `scope`, set elsewhere. */
export interface ScopeFetchOpts { projects?: string[]; teams?: string[]; projectId?: string; spaces?: string[] }

export class ScopeValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeValueError';
  }
}

export const YOURS_KEY = 'yours';

/** What a person chose for one source, kept beside its token (non-secret). Absent means "no choice": the narrower scope. */
export type StoredScope =
  | { kind: 'yours' }
  /** `values` are what the fetcher takes (Linear: team ids); `labels` are what people read (Linear: team keys). */
  | { kind: 'team'; values: string[]; labels: string[] };
const MAX_VALUES = 20;

const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
const LINEAR_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GITLAB_ID = /^\d{1,12}$/;
const GITLAB_PATH = /^[A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100})+$/;
const CONFLUENCE_SPACE = /^~?[A-Za-z0-9_.-]{1,32}$/;

const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function listOf(raw: unknown): string[] {
  const parts = typeof raw === 'string' ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : undefined;
  if (parts === undefined) throw new ScopeValueError('A scope value must be text.');
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') throw new ScopeValueError('A scope value must be text.');
    // Array items may themselves hold a comma list ("ALI,OPS").
    for (const piece of p.split(/[\s,]+/)) if (piece !== '') out.push(piece);
  }
  return out;
}

/** The valid, canonical values for one source (sorted by code unit, deduplicated). Throws a ScopeValueError that never contains the input. */
export function normaliseScopeValues(source: ScopedSource, raw: unknown): string[] {
  const given = listOf(raw);
  if (given.length === 0) throw new ScopeValueError('Name at least one value.');
  if (given.length > MAX_VALUES * 3) throw new ScopeValueError(`Name at most ${MAX_VALUES} values.`);
  let values: string[];
  switch (source) {
    case 'github': {
      const unique = [...new Set(given)];
      if (unique.length > 1) throw new ScopeValueError('A GitHub scope is one repo, written owner/repo.');
      if (!GITHUB_REPO.test(unique[0]!)) throw new ScopeValueError('A GitHub repo is written owner/repo, for example aligndottech/align-stack.');
      values = unique;
      break;
    }
    case 'jira':
      values = given.map((v) => {
        const key = v.toUpperCase();
        if (!JIRA_KEY.test(key)) throw new ScopeValueError('A Jira project key is capital letters and digits, 2 to 20 characters, for example ALI.');
        return key;
      });
      break;
    case 'linear':
      values = given.map((v) => {
        if (UUID.test(v.toLowerCase())) return v.toLowerCase();
        const key = v.toUpperCase();
        if (!LINEAR_KEY.test(key)) throw new ScopeValueError('A Linear team is its key (capital letters and digits, for example ENG) or its id.');
        return key;
      });
      break;
    case 'gitlab': {
      const unique = [...new Set(given)];
      if (unique.length > 1) throw new ScopeValueError('A GitLab scope is one project: its numeric id or its group/project path.');
      if (!GITLAB_ID.test(unique[0]!) && !GITLAB_PATH.test(unique[0]!)) throw new ScopeValueError('A GitLab project is its numeric id or its group/project path.');
      values = unique;
      break;
    }
    case 'confluence':
      values = given.map((v) => {
        if (!CONFLUENCE_SPACE.test(v)) throw new ScopeValueError('A Confluence space key is letters and digits, up to 32 characters (a personal space starts with ~).');
        return v;
      });
      break;
  }
  const unique = [...new Set(values)].sort(codeUnit);
  if (unique.length > MAX_VALUES) throw new ScopeValueError(`Name at most ${MAX_VALUES} values.`);
  return unique;
}

/** The `source_sync.scope_key` for a choice. GitHub keeps the `repo:` shape L5 already writes. */
export function scopeKeyOf(source: ScopedSource, labels: string[]): string {
  const sorted = [...labels].sort(codeUnit);
  return source === 'github' ? `repo:${sorted[0]}` : `${source}:${sorted.join(',')}`;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** A choice in words: "o/r", "Jira projects ALI, OPS". */
export function scopeLabel(source: ScopedSource, labels: string[]): string {
  const list = [...labels].sort(codeUnit).join(', ');
  switch (source) {
    case 'github': return list;
    case 'jira': return `${plural(labels.length, 'Jira project', 'Jira projects')} ${list}`;
    case 'linear': return `${plural(labels.length, 'Linear team', 'Linear teams')} ${list}`;
    case 'gitlab': return `the GitLab project ${list}`;
    case 'confluence': return `${plural(labels.length, 'Confluence space', 'Confluence spaces')} ${list}`;
  }
}

/** A stored `source_sync` row in words, for status. An unknown key shape is shown as it is: never a guess. */
export function describeScopeKey(source: string, scopeKey: string, scope: 'yours' | 'team'): string {
  if (scope === 'yours') return 'your own items';
  if (scopeKey.startsWith('repo:')) return `everyone's items in ${scopeKey.slice('repo:'.length)}`;
  const prefix = `${source}:`;
  if ((SCOPED_SOURCES as readonly string[]).includes(source) && source !== 'github' && scopeKey.startsWith(prefix)) {
    const labels = scopeKey.slice(prefix.length).split(',').filter((l) => l !== '');
    if (labels.length > 0) return `everyone's items in ${scopeLabel(source as ScopedSource, labels)}`;
  }
  return `everyone's items in ${scopeKey}`;
}

/** What to hand each fetcher for a team scope. GitHub's repo travels as `repo`, not here. */
export function fetchOptsFor(source: ScopedSource, values: string[]): ScopeFetchOpts {
  switch (source) {
    case 'jira': return { projects: values };
    case 'linear': return { teams: values };
    case 'gitlab': return { projectId: values[0]! };
    case 'confluence': return { spaces: values };
    case 'github': return {};
  }
}

/** The plain-words line shown once per source before the first team read (plan, Phase L4). */
export function disclosureText(source: ScopedSource, labels: string[]): string {
  return `Importing items from everyone in ${scopeLabel(source, labels)} that your token can read. They stay on this machine. To read only your own: align connect ${source} --scope yours`;
}

/** Sources with no named scope to pick. Slack, Notion and Teams already read all the token can see; Zoom cannot read more. */
export const FIXED_SCOPES: Record<string, { scope: 'yours' | 'team'; text: string }> = {
  slack: { scope: 'team', text: "everyone's threads in the channels your token is in" },
  notion: { scope: 'team', text: 'every page shared with your integration' },
  teams: { scope: 'team', text: 'all channels in the teams you have joined' },
  zoom: { scope: 'yours', text: 'only your own cloud recordings. Reading the whole account needs an account admin token, which Align does not ask for' },
};
