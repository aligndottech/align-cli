/**
 * L4: which scope a source is read under, and changing it. The one place the CLI (`align connect`, `align sync`) and the MCP tool
 * (`align_scope`) both decide and write, so a change made by an agent takes exactly the path a person's does.
 *
 * Scope is one of two things per source (Decision 7): "yours" (items you are involved in) or "team" (everyone's, in a NAMED place the
 * token can see: a repo, Jira projects, Linear teams, a GitLab project, Confluence spaces). There is no "everything": a team scope
 * always has a name. Zoom is always yours; Slack, Notion and Teams already read all the token can see and have nothing to name.
 *
 * Where it lives:
 * - the CHOICE is in the config store beside the token (config.ts `getConnectorScope`), so forgetting the connector removes it;
 * - each scope has its own `source_sync` row, keyed by `scopeKeyOf`, with the source's window and its own watermark.
 *   Changing scope adds or reuses a row and never touches another one, and never deletes an imported item.
 *
 * Fail direction: an unreadable, missing or unknown choice reads as "yours", the narrower scope. The only blocked case is Confluence
 * with no spaces, which has no "yours" to fall back to (its API lists whatever the token can read).
 */
import fs from 'node:fs';
import { CAPTURE_SOURCES } from './capture-sources.js';
import {
  type FetchLike, findConfluenceSpace, findJiraProject, findLinearTeam, githubRepoVisibility, gitlabProjectVisibility, listConfluenceSpaces, listJiraProjects,
  listLinearTeams, ScopeLookupError,
} from './scope-choices.js';
import {
  type ActiveScope, describeScopeKey, disclosureText, fetchOptsFor, FIXED_SCOPES, normaliseScopeValues, SCOPED_SOURCES, type ScopedSource, type ScopeFetchOpts,
  scopeKeyOf, ScopeValueError, type StoredScope, YOURS_KEY,
} from './scope-values.js';
import { adoptScope, readRows } from './sync/sync-state.js';
import { inheritedWindowSince } from './sync/window.js';

/** What the scope code needs from the config store, so a test (or the MCP server) hands it a plain object. */
export interface ScopeStore {
  getScope(source: string): StoredScope | null;
  saveScope(source: string, scope: StoredScope): void;
  clearScope(source: string): void;
  /** The saved connector fields (token, email, domain), or null when the source is not connected. */
  fields(source: string): Record<string, string> | null;
  /** Told for THIS scope of the source (per source and scope: a wider scope set later is announced again). */
  isDisclosed(source: string, scopeKey: string): boolean;
  markDisclosed(source: string, scopeKey: string): void;
  /** Forget every scope of the source that was told (narrowing to yours, forgetting the connector): a wider scope later is announced again. */
  clearDisclosed(source: string): void;
}

/**
 * The disclosure was shown to a person for this scope: remember it, and if an agent's choice of exactly this scope was waiting
 * for that, it is active now. The one place a pending scope becomes active.
 */
export function markTold(store: ScopeStore, source: string, scopeKey: string): void {
  store.markDisclosed(source, scopeKey);
  const s = store.getScope(source);
  if (s?.kind === 'team' && s.pending && isScoped(source) && scopeKeyOf(source, s.labels) === scopeKey) {
    store.saveScope(source, { kind: 'team', values: s.values, labels: s.labels });
  }
}

export interface ScopeDeps {
  store: ScopeStore;
  /** The local graph, or undefined when there is none yet. Never created from here. */
  dbPath: string | undefined;
  now(): Date;
  /** Is a person at a terminal? Only then is a waiting team scope shown its disclosure and activated. */
  isTty(): boolean;
  /** `owner/repo` when the folder's remote is on GitHub. */
  cwdRepo(): Promise<string | undefined>;
  /** `group/project` when the folder's remote is on gitlab.com. */
  cwdGitlabProject(): Promise<string | undefined>;
  fetch: FetchLike;
  /** Cap on how many projects, spaces or teams a lookup lists before it calls the list truncated. Tests lower it; absent is the real cap. */
  listMax?: number;
}

export interface ResolvedScope {
  scope: 'yours' | 'team';
  /** The `source_sync.scope_key` this read belongs to. */
  scopeKey: string;
  /** GitHub team scope: the repo. */
  repo?: string;
  /** The option the other fetchers take for a team scope. */
  extras: ScopeFetchOpts;
  /** In words, for status and reports. */
  label: string;
  /** chosen: a person set it. detected: this folder's remote. default: nothing was set. */
  origin: 'chosen' | 'detected' | 'default';
  /** Set when this source must not be read at all until the person acts (Confluence with no spaces). */
  blocked?: string;
  /** One line worth saying about this scope: why it is only yours, or how to widen it. */
  note?: string;
  /** True when an agent's team choice for this source is waiting for a person; this result is the scope that stays in force meanwhile. */
  pendingConfirm?: boolean;
  /** True when this result is an agent's waiting scope offered to a person: the caller shows the disclosure, asks, and only a Yes makes it active (markTold). */
  activates?: boolean;
  /** Set for a FOREGROUND team read the person has not been told about yet. The caller prints it, then marks it disclosed. */
  disclosure?: string;
}

const YOURS_LABEL = 'your own items';
const labelOf = (source: string): string => (CAPTURE_SOURCES as Record<string, { label: string }>)[source]?.label ?? source;
const isScoped = (source: string): source is ScopedSource => (SCOPED_SOURCES as readonly string[]).includes(source);

function yours(origin: ResolvedScope['origin'], note?: string): ResolvedScope {
  return { scope: 'yours', scopeKey: YOURS_KEY, extras: {}, label: YOURS_LABEL, origin, ...(note !== undefined ? { note } : {}) };
}

function team(source: ScopedSource, values: string[], labels: string[], origin: ResolvedScope['origin'], deps: ScopeDeps, foreground: boolean): ResolvedScope {
  const scopeKey = scopeKeyOf(source, labels);
  return {
    scope: 'team', scopeKey, extras: fetchOptsFor(source, values), label: describeScopeKey(source, scopeKey, 'team'), origin,
    ...(source === 'github' ? { repo: values[0]! } : {}),
    ...(foreground && !deps.store.isDisclosed(source, scopeKey) ? { disclosure: disclosureText(source, labels) } : {}),
  };
}

/** The line for a repo or project the token cannot see (P0 measured GitHub answering 422 for a private repo). */
export function cannotSeeNote(source: 'github' | 'gitlab', place: string): string {
  return source === 'github'
    ? `Your GitHub token cannot see ${place}, so only items you are involved in were imported. Reconnect with repo access: align connect github`
    : `Your GitLab token cannot see ${place}, so only your own merge requests were imported. Reconnect with access: align connect gitlab`;
}

/** Confluence has no "only yours": with no chosen spaces it reads nothing. */
export const CONFLUENCE_NEEDS_SPACES = 'Confluence reads only the spaces you choose, and none are chosen yet. Pick them: align connect --source confluence --spaces ENG,OPS';

const WIDEN_FLAG: Record<string, string> = { jira: '--projects KEYS', linear: '--teams KEYS' };

/**
 * Which scope a source is read under right now. `foreground` is a person at a terminal (`align connect`, `align sync`): only there is
 * a disclosure returned, and only there is an auto-detected team scope read before the disclosure was shown. A background run reads
 * what a person chose, or what they were already told about, and otherwise stays at yours.
 */
export async function resolveScope(source: string, deps: ScopeDeps, o: { foreground: boolean }): Promise<ResolvedScope> {
  if (!isScoped(source)) return yours('default');
  const stored = deps.store.getScope(source);
  // "Foreground" means a person at a terminal: without one nothing is announced, confirmed or widened by the folder.
  o = { foreground: o.foreground && deps.isTty() };
  if (stored?.kind === 'team' && stored.pending) {
    const person = o.foreground;
    // Only a person at a terminal is shown the disclosure and asked. Anything else keeps what was in force. A pending scope is NEVER
    // promoted silently: the disclosure is shown every time, even if this scope was told before, and the caller must get an explicit Yes.
    if (person) {
      return { ...team(source, stored.values, stored.labels, 'chosen', deps, true), disclosure: disclosureText(source, stored.labels), activates: true };
    }
    const kept = await resolveFrom(source, stored.pending.previous, deps, { foreground: false });
    return { ...kept, pendingConfirm: true, note: `Team scope for ${source} is waiting for you to confirm: run \`align sync ${source}\` (it will show what it reads)` };
  }
  return resolveFrom(source, stored, deps, o);
}

async function resolveFrom(source: ScopedSource, stored: StoredScope | ActiveScope | null, deps: ScopeDeps, o: { foreground: boolean }): Promise<ResolvedScope> {
  if (stored?.kind === 'team') return team(source, stored.values, stored.labels, 'chosen', deps, o.foreground);
  if (source === 'confluence') {
    return {
      ...yours('default'),
      blocked: CONFLUENCE_NEEDS_SPACES,
    };
  }
  if (stored?.kind === 'yours') return yours('chosen');
  if (source === 'github' || source === 'gitlab') return autoDetected(source, deps, o.foreground);
  return yours('default', `Reading only your own items. To read a team's: align connect --source ${source} ${WIDEN_FLAG[source] ?? ''}`.trim());
}

/** The folder's remote is gitlab.com; a token saved for another host would read a different project of the same path. */
function selfManagedGitlab(deps: ScopeDeps, source: string): boolean {
  const domain = deps.store.fields(source)?.['domain'];
  return source === 'gitlab' && !!domain && domain !== 'gitlab.com';
}

async function autoDetected(source: 'github' | 'gitlab', deps: ScopeDeps, foreground: boolean): Promise<ResolvedScope> {
  const place = selfManagedGitlab(deps, source) ? undefined : source === 'github' ? await deps.cwdRepo() : await deps.cwdGitlabProject();
  if (place === undefined) {
    return yours('default', source === 'github'
      ? "Reading only your own GitHub items (this folder is not a GitHub repo). To read everyone's in a repo: align connect --source github --repo owner/repo"
      : "Reading only your own merge requests (this folder is not a GitLab project). To read everyone's in a project: align connect --source gitlab --gitlab-project group/project");
  }
  // A background run must not widen by itself: until the person has been told what a team read is, it stays at yours.
  if (!foreground && !deps.store.isDisclosed(source, scopeKeyOf(source, [place]))) return yours('default');
  const fields = deps.store.fields(source);
  const seen = fields?.['token']
    ? source === 'github' ? await githubRepoVisibility(fields['token'], place, deps.fetch) : await gitlabProjectVisibility(fields, place, deps.fetch)
    : 'unknown';
  if (seen === 'invisible') return yours('default', cannotSeeNote(source, place));
  // 'unknown' proceeds: a probe that could not answer is not evidence of a refusal, and the fetch reports its own.
  return team(source, [place], [place], 'detected', deps, foreground);
}

// ---------------------------------------------------------------------------------------------------------------------
// Changing a scope

/** `unattended`: a command line nobody was at (no terminal, --json): like an agent's, a widening it asks for waits for a person. */
export type ChangedBy = { via: 'cli'; unattended?: boolean } | { via: 'mcp'; agent: string };
export type SetInput = { scope: 'yours' } | { scope: 'team'; values: unknown };

/** A change that was refused. The message is written for the person and never carries a value that was refused. */
export class ScopeRefusal extends Error {
  constructor(message: string, readonly kind: 'unknown_source' | 'fixed' | 'not_connected' | 'no_yours' | 'invalid' | 'not_visible' | 'invisible' | 'unverified' | 'lookup') {
    super(message);
    this.name = 'ScopeRefusal';
  }
}

export interface SetScopeResult {
  source: ScopedSource;
  scope: 'yours' | 'team';
  scopeKey: string;
  label: string;
  /** True when this scope had no `source_sync` row before: its first sync reads the whole window. */
  newRow: boolean;
  /** True when an agent set a team scope: it waits for a person to confirm at a terminal and is not read until then. */
  pending?: boolean;
  /** What changed and what it costs, in words. */
  text: string;
  /** The plain-words team disclosure, for a team scope. Always returned: the person may not be at the terminal. */
  disclosure?: string;
}

const day = (iso: string): string => iso.slice(0, 10);

interface Verified { values: string[]; labels: string[] }

async function verify(source: ScopedSource, raw: unknown, deps: ScopeDeps, fields: Record<string, string>): Promise<Verified> {
  let given: string[];
  try { given = normaliseScopeValues(source, raw); } catch (e) {
    if (e instanceof ScopeValueError) throw new ScopeRefusal(`${e.message} Nothing was changed.`, 'invalid');
    throw e;
  }
  const name = labelOf(source);
  try {
    switch (source) {
      case 'github': {
        const seen = await githubRepoVisibility(fields['token'] ?? '', given[0]!, deps.fetch);
        if (seen === 'invisible') throw new ScopeRefusal(`Your GitHub token cannot see the repo you named. Nothing was changed. Reconnect with repo access: align connect github`, 'invisible');
        if (seen === 'unknown') throw new ScopeRefusal(`Align could not check whether your GitHub token can see the repo you named (GitHub did not answer clearly). Nothing was changed; try again.`, 'unverified');
        return { values: given, labels: given };
      }
      case 'gitlab': {
        const seen = await gitlabProjectVisibility(fields, given[0]!, deps.fetch);
        if (seen === 'invisible') throw new ScopeRefusal(`Your GitLab token cannot see the project you named. Nothing was changed.`, 'not_visible');
        if (seen === 'unknown') throw new ScopeRefusal(`Align could not check whether your GitLab token can see the project you named. Nothing was changed; try again.`, 'unverified');
        return { values: given, labels: given };
      }
      case 'jira':
      case 'confluence': {
        const cap = deps.listMax !== undefined ? { max: deps.listMax } : {};
        const listed = source === 'jira' ? await listJiraProjects(fields, deps.fetch, cap) : await listConfluenceSpaces(fields, deps.fetch, cap);
        const visible = new Set(listed.items.map((x) => x.key));
        let missing = given.filter((g) => !visible.has(g));
        // A truncated list cannot say a key is invisible: ask for each missing key directly.
        if (listed.truncated && missing.length > 0) {
          const still: string[] = [];
          for (const k of missing) if (!(source === 'jira' ? await findJiraProject(fields, k, deps.fetch) : await findConfluenceSpace(fields, k, deps.fetch))) still.push(k);
          missing = still;
        }
        if (missing.length > 0) {
          throw new ScopeRefusal(`Your ${name} token cannot see ${missing.length} of the ${source === 'jira' ? 'projects' : 'spaces'} you gave (the values are not printed back).${listed.truncated ? ` The list was cut off after ${listed.items.length}, so each was also asked for directly.` : ''} Nothing was changed.`, 'not_visible');
        }
        return { values: given, labels: given };
      }
      case 'linear': {
        const listed = await listLinearTeams(fields, deps.fetch);
        const found = given.map((g) => listed.items.find((t) => t.id === g || t.key === g));
        if (listed.truncated) {
          for (let i = 0; i < given.length; i++) if (found[i] === undefined) found[i] = await findLinearTeam(fields, given[i]!, deps.fetch);
        }
        const missing = given.filter((_, i) => found[i] === undefined);
        if (missing.length > 0) {
          throw new ScopeRefusal(`Your Linear token cannot see ${missing.length} of the teams you gave (the values are not printed back).${listed.truncated ? ` The list was cut off after ${listed.items.length}, so each key was also asked for directly.` : ''} Nothing was changed.`, 'not_visible');
        }
        const hits = found as Array<{ id: string; key: string }>;
        return { values: hits.map((t) => t.id), labels: hits.map((t) => t.key) };
      }
    }
  } catch (e) {
    if (e instanceof ScopeLookupError) throw new ScopeRefusal(`${e.message} Nothing was changed.`, 'lookup');
    throw e;
  }
}

/** A scope that has been checked against what the token can see, ready to be written. */
export interface Choice {
  scope: 'yours' | 'team';
  scopeKey: string;
  label: string;
  /** What the fetcher takes (Linear: team ids). Empty for yours. */
  values: string[];
  /** What people read (Linear: team keys). Empty for yours. */
  labels: string[];
}

/**
 * Check a requested scope WITHOUT writing anything: refuses (ScopeRefusal) what is unknown, fixed, not connected, malformed, or not
 * visible to the token. `fields` are the connector fields to check with - the saved ones, or the in-flight ones of a connect whose
 * token is not saved yet.
 */
export async function chooseScope(deps: ScopeDeps, source: string, input: SetInput, fields: Record<string, string> | null): Promise<Choice & { source: ScopedSource }> {
  if (!isScoped(source)) {
    const fixed = FIXED_SCOPES[source];
    if (fixed) throw new ScopeRefusal(`${labelOf(source)} reads ${fixed.text}. There is no scope to choose for it.`, 'fixed');
    throw new ScopeRefusal(`Unknown source. A scope can be set for: ${SCOPED_SOURCES.join(', ')}.`, 'unknown_source');
  }
  if (!fields?.['token']) {
    throw new ScopeRefusal(`${labelOf(source)} is not connected, so its scope cannot be set. Connecting needs a token only the person can supply: align connect ${source}`, 'not_connected');
  }
  if (input.scope === 'yours') {
    if (source === 'confluence') {
      throw new ScopeRefusal('Confluence has no "only yours" scope: it reads the spaces you choose. Name them: align connect --source confluence --spaces ENG,OPS', 'no_yours');
    }
    return { source, scope: 'yours', scopeKey: YOURS_KEY, label: YOURS_LABEL, values: [], labels: [] };
  }
  const v = await verify(source, input.values, deps, fields);
  const scopeKey = scopeKeyOf(source, v.labels);
  return { source, scope: 'team', scopeKey, label: describeScopeKey(source, scopeKey, 'team'), values: v.values, labels: v.labels };
}

/** Write a checked choice: the stored preference, and the scope's own `source_sync` row (the source's window, no watermark). Deletes nothing. */
/**
 * `windowSince` is the window a connect actually READ (its `--since`), given only when the person gave one; it becomes the window of a NEW
 * scope row so the next sync does not read it all again. An existing row keeps its own. Absent: the source's window.
 */
export function commitScope(deps: ScopeDeps, source: ScopedSource, choice: Choice, by: ChangedBy, windowSince?: string | null): { newRow: boolean; pending: boolean; row?: { high_water: string | null; window_since: string | null } } {
  if (choice.scope === 'team') {
    // An AGENT's team choice waits for a person (the disclosure at a terminal); what was in force stays in force until then.
    // Re-choosing the scope that is already active is not a change, so it needs no confirmation.
    const current = deps.store.getScope(source);
    const active: ActiveScope | null = current === null ? null : current.kind === 'team' && current.pending ? current.pending.previous : current.kind === 'team' ? { kind: 'team', values: current.values, labels: current.labels } : current;
    const same = active?.kind === 'team' && scopeKeyOf(source, active.labels) === choice.scopeKey;
    const waits = by.via === 'mcp' || by.unattended === true;
    deps.store.saveScope(source, waits && !same
      ? { kind: 'team', values: choice.values, labels: choice.labels, pending: { previous: active } }
      : { kind: 'team', values: choice.values, labels: choice.labels });
  }
  // "Yours" is written down for every source that has one: otherwise GitHub and GitLab widen again from the folder's remote, and Jira
  // and Linear from the keys local decisions cite, as if nothing had been chosen.
  else {
    deps.store.saveScope(source, { kind: 'yours' });
    // Narrowed: a wider scope chosen later is announced again.
    deps.store.clearDisclosed(source);
  }
  const pending = deps.store.getScope(source)?.kind === 'team' && (deps.store.getScope(source) as { pending?: unknown }).pending !== undefined;
  if (deps.dbPath === undefined || !fs.existsSync(deps.dbPath)) return { newRow: true, pending };
  const window = windowSince !== undefined ? windowSince : inheritedWindowSince(readRows(deps.dbPath, source), deps.now());
  const adopted = adoptScope(deps.dbPath, { source, scopeKey: choice.scopeKey, scope: choice.scope }, window, { via: by.via, agent: by.via === 'mcp' ? by.agent : null });
  return { newRow: adopted.created, pending, row: adopted.row };
}

/**
 * Set a source's scope. The ONE writer: `align_scope set` ends here, and `align connect --scope ...` ends in the same
 * chooseScope + commitScope pair. Refuses (ScopeRefusal) rather than guessing, and stores nothing on any refusal.
 * Never deletes an item.
 */
export async function setScope(deps: ScopeDeps, source: string, input: SetInput, by: ChangedBy): Promise<SetScopeResult> {
  const choice = await chooseScope(deps, source, input, deps.store.fields(source));
  const { newRow: created, pending, row } = commitScope(deps, choice.source, choice, by);
  const name = labelOf(choice.source);
  const result: SetScopeResult = { source: choice.source, scope: choice.scope, scopeKey: choice.scopeKey, label: choice.label, newRow: created, text: '' };
  if (choice.scope === 'yours') {
    result.text = `${name} now reads only your own items. Items already imported from the wider scope stay in your graph; they are no longer refreshed.`;
    return result;
  }
  const back = row?.high_water ? day(row.high_water) : undefined;
  const reach = row === undefined || row.window_since === null
    ? `for all the history its ceiling allows`
    : `back to ${day(row.window_since)}`;
  result.text = created || back === undefined
    ? `${name} now reads ${choice.label}. This scope has not been read before, so the next sync re-reads ${name} ${reach} for it. That can take a few minutes and uses part of your ${name} rate limit. Nothing already imported is deleted.`
    : `${name} now reads ${choice.label}. This scope was read before, so the next sync catches up since ${back}. Nothing already imported is deleted.`;
  result.disclosure = disclosureText(choice.source, choice.labels);
  if (pending) {
    result.pending = true;
    result.text = `${name} will read ${choice.label} once the person confirms it. It is waiting for the person: nothing reads it in the background, or when an agent runs a sync, until they run \`align sync ${choice.source}\` at a terminal, which shows what it reads first. Until then ${name} keeps its current scope. When confirmed, the first sync re-reads ${name} ${reach} for this scope (a few minutes, some of its rate limit). Nothing already imported is deleted.`;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Viewing

export interface ScopeView {
  source: string;
  /** unset: Confluence with no spaces, which reads nothing until the person picks some. */
  kind: 'yours' | 'team' | 'unset';
  scope_key: string;
  /** In words. */
  label: string;
  /** The names a team scope covers (repo, project keys, team keys, space keys). */
  values?: string[];
  /** Whether `setScope` can change it. False for Zoom, Slack, Notion and Teams. */
  can_set: boolean;
  origin: 'chosen' | 'detected' | 'default' | 'fixed';
  /** An agent's team choice waiting for a person to confirm it at a terminal, in words. Not in force. */
  waiting?: string;
}

const VIEW_ORDER = ['github', 'jira', 'confluence', 'slack', 'teams', 'gitlab', 'linear', 'notion', 'zoom'] as const;

/**
 * Each connected source's scope as a sync here would read it. Makes no network call: a GitHub repo found from the folder is reported as
 * what the next sync will try, and the sync itself checks the token can see it.
 */
export async function viewScopes(deps: ScopeDeps): Promise<ScopeView[]> {
  const out: ScopeView[] = [];
  for (const source of VIEW_ORDER) {
    if (!deps.store.fields(source)?.['token']) continue;
    const fixed = FIXED_SCOPES[source];
    if (fixed) {
      out.push({ source, kind: fixed.scope, scope_key: YOURS_KEY, label: fixed.text, can_set: false, origin: 'fixed' });
      continue;
    }
    const raw = deps.store.getScope(source);
    // A waiting agent choice is not in force: show what is, and what is waiting.
    const waitingKey = raw?.kind === 'team' && raw.pending ? raw : undefined;
    const stored: StoredScope | ActiveScope | null = waitingKey ? waitingKey.pending!.previous : raw;
    const waiting = waitingKey ? { waiting: describeScopeKey(source, scopeKeyOf(source as ScopedSource, waitingKey.labels), 'team') } : {};
    const push = (v: ScopeView): void => { out.push({ ...v, ...waiting }); };
    if (stored?.kind === 'team') {
      push({ source, kind: 'team', scope_key: scopeKeyOf(source as ScopedSource, stored.labels), label: describeScopeKey(source, scopeKeyOf(source as ScopedSource, stored.labels), 'team'), values: stored.labels, can_set: true, origin: 'chosen' });
    } else if (source === 'confluence') {
      push({ source, kind: 'unset', scope_key: YOURS_KEY, label: 'no spaces chosen, so nothing is read', can_set: true, origin: 'default' });
    } else if (stored?.kind === 'yours') {
      push({ source, kind: 'yours', scope_key: YOURS_KEY, label: YOURS_LABEL, can_set: true, origin: 'chosen' });
    } else {
      const place = selfManagedGitlab(deps, source) ? undefined : source === 'github' ? await deps.cwdRepo() : source === 'gitlab' ? await deps.cwdGitlabProject() : undefined;
      push(place !== undefined
        ? { source, kind: 'team', scope_key: scopeKeyOf(source as ScopedSource, [place]), label: describeScopeKey(source, scopeKeyOf(source as ScopedSource, [place]), 'team'), values: [place], can_set: true, origin: 'detected' }
        : { source, kind: 'yours', scope_key: YOURS_KEY, label: YOURS_LABEL, can_set: true, origin: 'default' });
    }
  }
  return out;
}
