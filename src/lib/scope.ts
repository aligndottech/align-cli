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
  type FetchLike, githubRepoVisibility, gitlabProjectVisibility, listConfluenceSpaces, listJiraProjects, listLinearTeams, ScopeLookupError,
} from './scope-choices.js';
import {
  describeScopeKey, disclosureText, fetchOptsFor, FIXED_SCOPES, normaliseScopeValues, SCOPED_SOURCES, type ScopedSource, type ScopeFetchOpts,
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
  isDisclosed(source: string): boolean;
  markDisclosed(source: string): void;
}

export interface ScopeDeps {
  store: ScopeStore;
  /** The local graph, or undefined when there is none yet. Never created from here. */
  dbPath: string | undefined;
  now(): Date;
  /** `owner/repo` when the folder's remote is on GitHub. */
  cwdRepo(): Promise<string | undefined>;
  /** `group/project` when the folder's remote is on gitlab.com. */
  cwdGitlabProject(): Promise<string | undefined>;
  fetch: FetchLike;
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
    ...(foreground && !deps.store.isDisclosed(source) ? { disclosure: disclosureText(source, labels) } : {}),
  };
}

/** The line for a repo or project the token cannot see (P0 measured GitHub answering 422 for a private repo). */
export function cannotSeeNote(source: 'github' | 'gitlab', place: string): string {
  return source === 'github'
    ? `Your GitHub token cannot see ${place}, so only items you are involved in were imported. Reconnect with repo access: align connect github`
    : `Your GitLab token cannot see ${place}, so only your own merge requests were imported. Reconnect with access: align connect gitlab`;
}

const WIDEN_FLAG: Record<string, string> = { jira: '--projects KEYS', linear: '--teams KEYS' };

/**
 * Which scope a source is read under right now. `foreground` is a person at a terminal (`align connect`, `align sync`): only there is
 * a disclosure returned, and only there is an auto-detected team scope read before the disclosure was shown. A background run reads
 * what a person chose, or what they were already told about, and otherwise stays at yours.
 */
export async function resolveScope(source: string, deps: ScopeDeps, o: { foreground: boolean }): Promise<ResolvedScope> {
  if (!isScoped(source)) return yours('default');
  const stored = deps.store.getScope(source);
  if (stored?.kind === 'team') return team(source, stored.values, stored.labels, 'chosen', deps, o.foreground);
  if (source === 'confluence') {
    return {
      ...yours('default'),
      blocked: 'Confluence reads only the spaces you choose, and none are chosen yet. Pick them: align connect confluence --spaces ENG,OPS',
    };
  }
  if (stored?.kind === 'yours') return yours('chosen');
  if (source === 'github' || source === 'gitlab') return autoDetected(source, deps, o.foreground);
  return yours('default', `Reading only your own items. To read a team's: align connect ${source} ${WIDEN_FLAG[source] ?? ''}`.trim());
}

async function autoDetected(source: 'github' | 'gitlab', deps: ScopeDeps, foreground: boolean): Promise<ResolvedScope> {
  const place = source === 'github' ? await deps.cwdRepo() : await deps.cwdGitlabProject();
  if (place === undefined) {
    return yours('default', source === 'github'
      ? "Reading only your own GitHub items (this folder is not a GitHub repo). To read everyone's in a repo: align connect github --repo owner/repo"
      : "Reading only your own merge requests (this folder is not a GitLab project). To read everyone's in a project: align connect gitlab --project group/project");
  }
  // A background run must not widen by itself: until the person has been told what a team read is, it stays at yours.
  if (!foreground && !deps.store.isDisclosed(source)) return yours('default');
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

export type ChangedBy = { via: 'cli' } | { via: 'mcp'; agent: string };
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
        if (seen === 'invisible') throw new ScopeRefusal(`Your GitHub token cannot see ${given[0]}. Nothing was changed. Reconnect with repo access: align connect github`, 'invisible');
        if (seen === 'unknown') throw new ScopeRefusal(`Align could not check whether your GitHub token can see ${given[0]} (GitHub did not answer clearly). Nothing was changed; try again.`, 'unverified');
        return { values: given, labels: given };
      }
      case 'gitlab': {
        const seen = await gitlabProjectVisibility(fields, given[0]!, deps.fetch);
        if (seen === 'invisible') throw new ScopeRefusal(`Your GitLab token cannot see ${given[0]}. Nothing was changed.`, 'not_visible');
        if (seen === 'unknown') throw new ScopeRefusal(`Align could not check whether your GitLab token can see ${given[0]}. Nothing was changed; try again.`, 'unverified');
        return { values: given, labels: given };
      }
      case 'jira':
      case 'confluence': {
        const visible = new Set((source === 'jira' ? await listJiraProjects(fields, deps.fetch) : await listConfluenceSpaces(fields, deps.fetch)).map((x) => x.key));
        const missing = given.filter((g) => !visible.has(g));
        if (missing.length > 0) {
          throw new ScopeRefusal(`Your ${name} token cannot see ${source === 'jira' ? 'these projects' : 'these spaces'}: ${missing.join(', ')}. Nothing was changed.`, 'not_visible');
        }
        return { values: given, labels: given };
      }
      case 'linear': {
        const teams = await listLinearTeams(fields, deps.fetch);
        const found = given.map((g) => teams.find((t) => t.id === g || t.key === g));
        const missing = given.filter((_, i) => found[i] === undefined);
        if (missing.length > 0) throw new ScopeRefusal(`Your Linear token cannot see these teams: ${missing.join(', ')}. Nothing was changed.`, 'not_visible');
        const hits = found as Array<{ id: string; key: string }>;
        return { values: hits.map((t) => t.id), labels: hits.map((t) => t.key) };
      }
    }
  } catch (e) {
    if (e instanceof ScopeLookupError) throw new ScopeRefusal(`${e.message} Nothing was changed.`, 'lookup');
    throw e;
  }
}

/**
 * Set a source's scope. The ONE writer: `align connect --scope ...` and `align_scope set` both end here, with different `by`.
 * Refuses (ScopeRefusal) rather than guessing, and stores nothing on any refusal. Never deletes an item.
 */
export async function setScope(deps: ScopeDeps, source: string, input: SetInput, by: ChangedBy): Promise<SetScopeResult> {
  if (!isScoped(source)) {
    const fixed = FIXED_SCOPES[source];
    if (fixed) throw new ScopeRefusal(`${labelOf(source)} reads ${fixed.text}. There is no scope to choose for it.`, 'fixed');
    throw new ScopeRefusal(`Unknown source "${source.slice(0, 16)}". A scope can be set for: ${SCOPED_SOURCES.join(', ')}.`, 'unknown_source');
  }
  const name = labelOf(source);
  const fields = deps.store.fields(source);
  if (!fields?.['token']) {
    throw new ScopeRefusal(`${name} is not connected, so its scope cannot be set. Connecting needs a token only the person can supply: align connect ${source}`, 'not_connected');
  }

  let resolved: { scope: 'yours' | 'team'; scopeKey: string; label: string; labels: string[] };
  if (input.scope === 'yours') {
    if (source === 'confluence') {
      throw new ScopeRefusal('Confluence has no "only yours" scope: it reads the spaces you choose. Name them: align connect confluence --spaces ENG,OPS', 'no_yours');
    }
    resolved = { scope: 'yours', scopeKey: YOURS_KEY, label: YOURS_LABEL, labels: [] };
  } else {
    const v = await verify(source, input.values, deps, fields);
    const scopeKey = scopeKeyOf(source, v.labels);
    resolved = { scope: 'team', scopeKey, label: describeScopeKey(source, scopeKey, 'team'), labels: v.labels };
    deps.store.saveScope(source, { kind: 'team', values: v.values, labels: v.labels });
  }
  if (resolved.scope === 'yours') {
    // GitHub (and GitLab) would otherwise widen again from the folder's remote, so "yours" is written down; the others default to it.
    if (source === 'github' || source === 'gitlab') deps.store.saveScope(source, { kind: 'yours' });
    else deps.store.clearScope(source);
  }

  let created = true;
  let row: { high_water: string | null; window_since: string | null } | undefined;
  if (deps.dbPath !== undefined && fs.existsSync(deps.dbPath)) {
    const window = inheritedWindowSince(readRows(deps.dbPath, source), deps.now());
    const adopted = adoptScope(deps.dbPath, { source, scopeKey: resolved.scopeKey, scope: resolved.scope }, window, { via: by.via, agent: by.via === 'mcp' ? by.agent : null });
    created = adopted.created;
    row = adopted.row;
  }

  const result: SetScopeResult = { source, scope: resolved.scope, scopeKey: resolved.scopeKey, label: resolved.label, newRow: created, text: '' };
  if (resolved.scope === 'yours') {
    result.text = `${name} now reads only your own items. Items already imported from the wider scope stay in your graph; they are no longer refreshed.`;
    return result;
  }
  const back = row?.high_water ? day(row.high_water) : undefined;
  const reach = row === undefined || row.window_since === null
    ? `for all the history its ceiling allows`
    : `back to ${day(row.window_since)}`;
  result.text = created || back === undefined
    ? `${name} now reads ${resolved.label}. This scope has not been read before, so the next sync re-reads ${name} ${reach} for it. That can take a few minutes and uses part of your ${name} rate limit. Nothing already imported is deleted.`
    : `${name} now reads ${resolved.label}. This scope was read before, so the next sync catches up since ${back}. Nothing already imported is deleted.`;
  result.disclosure = disclosureText(source, resolved.labels);
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
    const stored = deps.store.getScope(source);
    if (stored?.kind === 'team') {
      out.push({ source, kind: 'team', scope_key: scopeKeyOf(source as ScopedSource, stored.labels), label: describeScopeKey(source, scopeKeyOf(source as ScopedSource, stored.labels), 'team'), values: stored.labels, can_set: true, origin: 'chosen' });
    } else if (source === 'confluence') {
      out.push({ source, kind: 'unset', scope_key: YOURS_KEY, label: 'no spaces chosen, so nothing is read', can_set: true, origin: 'default' });
    } else if (stored?.kind === 'yours') {
      out.push({ source, kind: 'yours', scope_key: YOURS_KEY, label: YOURS_LABEL, can_set: true, origin: 'chosen' });
    } else {
      const place = source === 'github' ? await deps.cwdRepo() : source === 'gitlab' ? await deps.cwdGitlabProject() : undefined;
      out.push(place !== undefined
        ? { source, kind: 'team', scope_key: scopeKeyOf(source as ScopedSource, [place]), label: describeScopeKey(source, scopeKeyOf(source as ScopedSource, [place]), 'team'), values: [place], can_set: true, origin: 'detected' }
        : { source, kind: 'yours', scope_key: YOURS_KEY, label: YOURS_LABEL, can_set: true, origin: 'default' });
    }
  }
  return out;
}
