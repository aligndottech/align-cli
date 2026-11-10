import { createHash } from 'node:crypto';

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
export const SCOPED_SOURCES = ['github', 'jira', 'linear', 'gitlab', 'confluence', 'notion'] as const;
export type ScopedSource = (typeof SCOPED_SOURCES)[number];

/** The option each fetcher takes for a team scope. GitHub's is `repo` + `scope`, set elsewhere. Jira `jql` and Linear `projects` narrow (connector-core 0.14). */
export interface ScopeFetchOpts {
  projects?: string[]; teams?: string[]; projectId?: string; spaces?: string[]; jql?: string;
  /** Notion page or database ids, and Confluence page ids: read only these and what is under them (connector-core 0.15). */
  pages?: string[]; ancestors?: string[];
}

/**
 * A team scope narrowed to one part: a Jira board (its filter, read at choice time and kept) or the person's own JQL, always inside
 * one project; or Linear projects inside the chosen team. Stored on disk as kind "narrowed" (config.ts), so an older CLI reads it as
 * yours and never as the whole project.
 */
export type Narrowing =
  | { by: 'board'; id: string; name: string; jql: string }
  | { by: 'jql'; jql: string }
  | { by: 'projects'; ids: string[]; names: string[] }
  /** Notion: only these pages or databases and what is under them. The ids are also the scope's values. */
  | { by: 'pages'; ids: string[]; names: string[] }
  /** Confluence: only these pages and their descendants, inside the chosen spaces. */
  | { by: 'ancestors'; ids: string[]; names: string[] };

export class ScopeValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeValueError';
  }
}

export const YOURS_KEY = 'yours';

/** What a person chose for one source, kept beside its token (non-secret). Absent means "no choice": the narrower scope. */
export type ActiveScope =
  | { kind: 'yours' }
  /** The person chose to read nothing from this source in this repo. Stored per repo, like any choice. */
  | { kind: 'skip' }
  /** `values` are what the fetcher takes (Linear: team ids); `labels` are what people read (Linear: team keys). */
  | { kind: 'team'; values: string[]; labels: string[]; narrow?: Narrowing };
/**
 * `pending` marks a team scope an AGENT chose (align_scope via MCP): nothing reads it in the background, or for an agent running
 * `align sync`, until a person at a terminal has been shown the disclosure. `previous` is what stays in force until then (null: nothing
 * was chosen before, so the source's default applies).
 */
export type StoredScope =
  | { kind: 'yours' }
  | { kind: 'skip' }
  | { kind: 'team'; values: string[]; labels: string[]; narrow?: Narrowing; pending?: { previous: ActiveScope | null } };
const MAX_VALUES = 20;

const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
const LINEAR_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GITLAB_ID = /^\d{1,12}$/;
const GITLAB_PATH = /^[A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100})+$/;
const NOTION_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** A Confluence page id: digits. */
export const CONFLUENCE_PAGE_ID = /^\d{1,19}$/;
const CONFLUENCE_SPACE = /^~?[A-Za-z0-9_.-]{1,32}$/;

/** A segment that is only dots (`.`, `..`) would walk out of the path it is placed in. */
const dotsOnly = (segments: string[]): boolean => segments.some((s) => /^\.+$/.test(s));

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
      if (!GITHUB_REPO.test(unique[0]!) || dotsOnly(unique[0]!.split('/'))) throw new ScopeValueError('A GitHub repo is written owner/repo, for example aligndottech/align-stack.');
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
      if (!GITLAB_ID.test(unique[0]!) && (!GITLAB_PATH.test(unique[0]!) || dotsOnly(unique[0]!.split('/')))) throw new ScopeValueError('A GitLab project is its numeric id or its group/project path.');
      values = unique;
      break;
    }
    case 'confluence':
      values = given.map((v) => {
        if (!CONFLUENCE_SPACE.test(v)) throw new ScopeValueError('A Confluence space key is letters and digits, up to 32 characters (a personal space starts with ~).');
        return v;
      });
      break;
    case 'notion':
      values = given.map((v) => {
        const id = v.toLowerCase();
        if (!NOTION_ID.test(id)) throw new ScopeValueError('A Notion page id is 32 letters and digits (a-f, 0-9), with or without dashes: the end of the page\'s URL.');
        // One spelling per page, so the same page chosen twice is one value.
        const hex = id.replace(/-/g, '');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      });
      break;
  }
  const unique = [...new Set(values)].sort(codeUnit);
  if (unique.length > MAX_VALUES) throw new ScopeValueError(`Name at most ${MAX_VALUES} values.`);
  return unique;
}

/** The `source_sync.scope_key` for a choice. GitHub keeps the `repo:` shape L5 already writes. */
export function scopeKeyOf(source: ScopedSource, labels: string[], narrow?: Narrowing): string {
  const sorted = [...labels].sort(codeUnit);
  if (source === 'github') return `repo:${sorted[0]}`;
  const base = `${source}:${sorted.join(',')}`;
  // A narrowing is its own row (and watermark). A JQL is hashed: it is never written into a key a person can read.
  if (narrow === undefined) return base;
  if (narrow.by === 'board') return `${base}#board=${narrow.id}`;
  if (narrow.by === 'jql') return `${base}#jql=${createHash('sha256').update(narrow.jql).digest('hex').slice(0, 12)}`;
  // Notion's pages ARE its values, so they are already in the base key.
  if (narrow.by === 'pages') return base;
  if (narrow.by === 'ancestors') return `${base}#ancestors=${[...narrow.ids].sort(codeUnit).join(',')}`;
  return `${base}#projects=${[...narrow.ids].sort(codeUnit).join(',')}`;
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
    case 'notion': return `${plural(labels.length, 'Notion page', 'Notion pages')} ${list}`;
  }
}

/** The place a stored team-scope key names, in words: "o/r", "Jira projects ALI, OPS". An unknown key shape is shown as it is: never a guess. */
export function labelOfScopeKey(source: string, scopeKey: string): string {
  if (scopeKey.startsWith('repo:')) return scopeKey.slice('repo:'.length);
  const prefix = `${source}:`;
  if ((SCOPED_SOURCES as readonly string[]).includes(source) && source !== 'github' && scopeKey.startsWith(prefix)) {
    const labels = scopeKey.slice(prefix.length).split('#')[0]!.split(',').filter((l) => l !== '');
    if (labels.length > 0) return scopeLabel(source as ScopedSource, labels);
  }
  return scopeKey;
}

/** A stored `source_sync` row in words, for status. */
export function describeScopeKey(source: string, scopeKey: string, scope: 'yours' | 'team'): string {
  if (scope === 'yours') return 'your own items';
  const place = labelOfScopeKey(source, scopeKey);
  const part = scopeKey.split('#')[1];
  if (part?.startsWith('board=')) return `issues on Jira board ${part.slice('board='.length)} in ${place}`;
  if (part?.startsWith('jql=')) return `issues matching your filter in ${place}`;
  if (part?.startsWith('ancestors=')) {
    const n = part.slice('ancestors='.length).split(',').length;
    return `pages under ${n} ${plural(n, 'page', 'pages')} in ${place}`;
  }
  if (source === 'notion') return `the ${place} and the pages under them`;
  if (part?.startsWith('projects=')) {
    const n = part.slice('projects='.length).split(',').length;
    return `issues in ${n} ${plural(n, 'Linear project', 'Linear projects')} of ${place}`;
  }
  return `everyone's items in ${place}`;
}

/** A team scope in words, naming its narrowing's part when it has one: "issues on the Payments board in Jira project AC". */
export function describeTeamScope(source: ScopedSource, labels: string[], narrow?: Narrowing): string {
  const place = scopeLabel(source, labels);
  if (narrow?.by === 'board') return `issues on the ${narrow.name} board in ${place}`;
  if (narrow?.by === 'jql') return `issues matching your filter in ${place}`;
  if (narrow?.by === 'projects') return `issues in ${plural(narrow.names.length, 'Linear project', 'Linear projects')} ${[...narrow.names].sort(codeUnit).join(', ')} of ${place}`;
  if (narrow?.by === 'pages') return `the ${plural(narrow.names.length, 'Notion page', 'Notion pages')} ${[...narrow.names].sort(codeUnit).join(', ')} and the pages under them`;
  if (narrow?.by === 'ancestors') return `pages under ${[...narrow.names].sort(codeUnit).join(', ')} in ${place}`;
  return describeScopeKey(source, scopeKeyOf(source, labels), 'team');
}

/** What to hand each fetcher for a team scope. GitHub's repo travels as `repo`, not here. */
export function fetchOptsFor(source: ScopedSource, values: string[], narrow?: Narrowing): ScopeFetchOpts {
  switch (source) {
    case 'jira': return { projects: values, ...(narrow?.by === 'board' || narrow?.by === 'jql' ? { jql: narrow.jql } : {}) };
    case 'linear': return { teams: values, ...(narrow?.by === 'projects' ? { projects: narrow.ids } : {}) };
    case 'gitlab': return { projectId: values[0]! };
    case 'confluence': return { spaces: values, ...(narrow?.by === 'ancestors' ? { ancestors: narrow.ids } : {}) };
    case 'notion': return { pages: values };
    case 'github': return {};
  }
}

/** The plain-words line shown once per source before the first team read (plan, Phase L4). */
export function disclosureText(source: ScopedSource, labels: string[], narrow?: Narrowing): string {
  const place = scopeLabel(source, labels);
  const tail = `They stay on this machine. To read only your own: align connect --source ${source} --scope yours`;
  if (narrow?.by === 'board') return `Importing issues on the ${narrow.name} board in ${place} that your token can read. Only ${labels.join(', ')} is read, even if the board shows other projects. ${tail}`;
  if (narrow?.by === 'jql') return `Importing issues matching your filter in ${place} that your token can read. Only ${labels.join(', ')} is read. ${tail}`;
  if (narrow?.by === 'pages') return `Importing the ${plural(narrow.names.length, 'Notion page', 'Notion pages')} ${[...narrow.names].sort(codeUnit).join(', ')} and the pages under them that your token can read. They stay on this machine. To read everything shared with your integration: align connect --source notion --scope yours`;
  if (narrow?.by === 'ancestors') return `Importing pages under ${[...narrow.names].sort(codeUnit).join(', ')} in ${place} that your token can read. ${tail}`;
  if (narrow?.by === 'projects') return `Importing issues in ${plural(narrow.names.length, 'Linear project', 'Linear projects')} ${[...narrow.names].sort(codeUnit).join(', ')} of ${place} that your token can read. ${tail}`;
  return `Importing items from everyone in ${place} that your token can read. ${tail}`;
}

/**
 * Say the team-scope disclosure the FIRST time a (source, scope) is read as team, then remember it was said. For the readers that do not go
 * through scope.ts (the per-source `align connect <source>` commands). Returns whether it spoke.
 */
export function discloseTeamScope(
  store: { isTeamScopeDisclosed(source: string, scopeKey: string): boolean; markTeamScopeDisclosed(source: string, scopeKey: string): void },
  source: ScopedSource, labels: string[], say: (line: string) => void,
): boolean {
  const key = scopeKeyOf(source, labels);
  if (store.isTeamScopeDisclosed(source, key)) return false;
  say(disclosureText(source, labels));
  store.markTeamScopeDisclosed(source, key);
  return true;
}

/**
 * Sources with no named scope to pick. Slack and Teams already read all the token can see; Zoom cannot read more. Notion is
 * ALSO a scoped source (pages): its entry here is the words for reading everything shared, which is what it reads with no pages chosen.
 */
export const FIXED_SCOPES: Record<string, { scope: 'yours' | 'team'; text: string }> = {
  slack: { scope: 'team', text: "everyone's threads in the channels your token is in" },
  notion: { scope: 'team', text: 'every page shared with your integration' },
  teams: { scope: 'team', text: 'all channels in the teams you have joined' },
  zoom: { scope: 'yours', text: 'only your own cloud recordings. Reading the whole account needs an account admin token, which Align does not ask for' },
};
