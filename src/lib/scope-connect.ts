/**
 * L4: choosing a scope while a source is being connected (`align connect --source <x>`, `align setup`).
 *
 * `decideConnectScope` runs BEFORE the fetch and returns what to fetch under; `fetchUnderScope` is the one call the connect loop makes:
 * decide, fetch, and only then write the choice. A fetch that fails writes nothing, and the token is still saved by the caller only
 * after the fetch succeeded, so a first connect has no saved token yet: every check here uses the IN-FLIGHT fields.
 *
 * What it decides, in order (a flag always wins, and a flag is checked against what the token can see before anything is fetched):
 * - GitHub and GitLab: the folder's remote decides, with no question (resolveScope). A repo the token cannot see is yours, said so.
 * - Jira and Linear: a picker on a terminal (cited keys preselected); otherwise the stored choice, else the cited keys the token can
 *   see, else yours with how to widen. A list that cannot be read never blocks: yours, and the reason is said.
 * - Confluence: spaces, picked, flagged or stored. With none, refused with the command (there is no "yours" to fall back to).
 * - Zoom: only yours, and it says why. Slack, Notion and Teams already read all the token can see: nothing to say.
 *
 * The team-scope disclosure is printed here, before the fetch, once per source. `quiet` (`--json`) prints nothing and does not mark
 * it told, so the next foreground run still tells the person.
 */
import * as p from '@clack/prompts';
import type { createConfigStore } from './config.js';
import type { CaptureFetchResult } from './fetchers/capture.js';
import { type Choice, chooseScope, commitScope, type ResolvedScope, resolveScope, type ScopeDeps, type SetInput } from './scope.js';
import { citedProjectKeys } from './scope-defaults.js';
import { realScopeDeps } from './scope-real.js';
import { listConfluenceSpaces, listJiraProjects, listLinearTeams, ScopeLookupError } from './scope-choices.js';
import { disclosureText, fetchOptsFor, FIXED_SCOPES, SCOPED_SOURCES, type ScopedSource } from './scope-values.js';
import { CAPTURE_SOURCES } from './capture-sources.js';
import type { FetchExtras, SyncWindow } from './since.js';

export interface ScopeFlags { scope?: string; repo?: string; projects?: string; teams?: string; gitlabProject?: string; spaces?: string }
export interface PickOption { value: string; label: string; hint?: string }
export interface ScopePrompts {
  /** The values the person chose, or null when they cancelled. */
  multiselect(message: string, options: PickOption[], initial: string[], o: { required: boolean }): Promise<string[] | null>;
}
export interface ConnectScopeCtx {
  /** The store, graph and network the scope code uses. `store.fields` is overlaid with the in-flight fields per source. */
  deps: ScopeDeps;
  interactive: boolean;
  /** `--json`: print nothing, and do not mark the disclosure told. */
  quiet: boolean;
  flags: ScopeFlags;
  prompts: ScopePrompts;
  /** Ticket prefixes local decisions cite (scope-defaults.ts), to preselect. */
  citedKeys(): string[];
  say(line: string): void;
}
export interface ScopeDecision {
  /** Handed to the source's fetch. */
  extras: FetchExtras;
  scope: 'yours' | 'team';
  label: string;
  /** Write the choice. Called once, after the fetch succeeded. */
  commit(): void;
}

const labelOf = (source: string): string => (CAPTURE_SOURCES as Record<string, { label: string }>)[source]?.label ?? source;
const isScoped = (source: string): source is ScopedSource => (SCOPED_SOURCES as readonly string[]).includes(source);
const VALUE_FLAG = { github: 'repo', jira: 'projects', linear: 'teams', gitlab: 'gitlabProject', confluence: 'spaces' } as const;
const FLAG_NAME = { repo: '--repo', projects: '--projects', teams: '--teams', gitlabProject: '--gitlab-project', spaces: '--spaces' } as const;
const FLAG_FOR = { repo: 'GitHub', projects: 'Jira', teams: 'Linear', gitlabProject: 'GitLab', spaces: 'Confluence' } as const;
const WHAT = { jira: 'Jira projects', linear: 'Linear teams', confluence: 'Confluence spaces' } as const;

/** Checked before any prompt or request. Returns the sentence to print with exit 2, or undefined when the flags are usable. */
export function checkScopeFlags(source: string | undefined, flags: ScopeFlags): string | undefined {
  const valueFlags = (Object.keys(FLAG_NAME) as Array<keyof typeof FLAG_NAME>).filter((k) => flags[k] !== undefined);
  if (flags.scope === undefined && valueFlags.length === 0) return undefined;
  if (source === undefined) return 'Scope flags (--scope, --repo, --projects, --teams, --gitlab-project, --spaces) need --source <id> to say which source they are for.';
  const fixed = FIXED_SCOPES[source];
  if (fixed) return `${labelOf(source)} reads ${fixed.text}. There is no scope to choose for it.`;
  if (!isScoped(source)) return 'That source has no scope to choose.';
  if (flags.scope !== undefined && flags.scope !== 'yours' && flags.scope !== 'team') return '--scope takes yours or team.';
  const wrong = valueFlags.find((k) => VALUE_FLAG[source] !== k);
  if (wrong !== undefined) return `${FLAG_NAME[wrong]} is for ${FLAG_FOR[wrong]}; ${labelOf(source)} takes ${FLAG_NAME[VALUE_FLAG[source]]}.`;
  const given = valueFlags.length > 0;
  if (flags.scope === 'yours' && given) return `Pass either --scope yours or ${FLAG_NAME[VALUE_FLAG[source]]}, not both.`;
  if (flags.scope === 'team' && !given && source !== 'github' && source !== 'gitlab') return `--scope team needs ${FLAG_NAME[VALUE_FLAG[source]]} to say which ${source === 'confluence' ? 'spaces' : source === 'jira' ? 'projects' : 'teams'}.`;
  return undefined;
}

function flagInput(source: ScopedSource, flags: ScopeFlags): SetInput | undefined {
  if (flags.scope === 'yours') return { scope: 'yours' };
  const value = flags[VALUE_FLAG[source]];
  return value !== undefined ? { scope: 'team', values: value } : undefined;
}

type Lister = (tokens: Record<string, string>, f: ScopeDeps['fetch']) => Promise<Array<{ key: string; name: string }>>;
const LISTERS: Partial<Record<ScopedSource, Lister>> = {
  jira: listJiraProjects,
  confluence: listConfluenceSpaces,
  linear: async (t, f) => (await listLinearTeams(t, f)).map(({ key, name }) => ({ key, name })),
};

/** Decide the scope of one source being connected, with the in-flight `tokens`. May print (disclosure, notes). Throws to refuse. */
export async function decideConnectScope(source: string, tokens: Record<string, string>, ctx: ConnectScopeCtx): Promise<ScopeDecision> {
  const tell = (line: string): void => { if (!ctx.quiet) ctx.say(line); };
  const fixed = FIXED_SCOPES[source];
  if (!isScoped(source)) {
    if (source === 'zoom' && fixed) tell(`${labelOf(source)} reads ${fixed.text}.`);
    return { extras: {}, scope: 'yours', label: 'your own items', commit() {} };
  }
  // The store, with this source's fields replaced by the ones in hand: a first connect has nothing saved to read.
  const deps: ScopeDeps = { ...ctx.deps, store: { ...ctx.deps.store, fields: (s) => (s === source ? tokens : ctx.deps.store.fields(s)) } };
  const blocked = (reason: string): Error => new Error(reason);

  const told = (labels: string[], team: boolean): void => {
    if (!team || deps.store.isDisclosed(source)) return;
    tell(disclosureText(source, labels));
    if (!ctx.quiet) deps.store.markDisclosed(source);
  };
  const fromChoice = (c: Choice): ScopeDecision => {
    told(c.labels, c.scope === 'team');
    const extras: FetchExtras = c.scope === 'yours'
      ? { resolved: true }
      : { resolved: true, ...(source === 'github' ? { repo: c.values[0]!, team: true } : fetchOptsFor(source, c.values)) };
    return { extras, scope: c.scope, label: c.label, commit: () => { commitScope(deps, source, c, { via: 'cli' }); } };
  };
  const fromResolved = (r: ResolvedScope): ScopeDecision => {
    if (r.blocked !== undefined) throw blocked(r.blocked);
    if (r.disclosure !== undefined) {
      tell(r.disclosure);
      if (!ctx.quiet) deps.store.markDisclosed(source);
    }
    if (r.note !== undefined) tell(r.note);
    return { extras: { resolved: true, ...(r.repo ? { repo: r.repo, team: true } : {}), ...r.extras }, scope: r.scope, label: r.label, commit() {} };
  };
  const resolved = async (): Promise<ScopeDecision> => fromResolved(await resolveScope(source, deps, { foreground: true }));
  const list = async (): Promise<Array<{ key: string; name: string }> | undefined> => {
    try { return await LISTERS[source]!(tokens, deps.fetch); } catch (e) {
      if (!(e instanceof ScopeLookupError)) throw e;
      if (source === 'confluence') throw blocked(`${e.message} Confluence reads only the spaces you choose, so nothing was read. Pick them: align connect --source confluence --spaces ENG,OPS`);
      tell(`Could not list your ${WHAT[source as keyof typeof WHAT]}: ${e.message}`);
      return undefined;
    }
  };

  const input = flagInput(source, ctx.flags);
  if (input) return fromChoice(await chooseScope(deps, source, input, tokens));

  if (source === 'github' || source === 'gitlab') {
    const d = await resolved();
    if (ctx.flags.scope === 'team' && d.scope === 'yours') {
      throw blocked(`--scope team needs a ${source === 'github' ? 'repo' : 'project'}: this folder is not one. Pass ${source === 'github' ? '--repo owner/repo' : '--gitlab-project group/project'}.`);
    }
    return d;
  }

  const stored = deps.store.getScope(source);
  const confluence = source === 'confluence';
  if (ctx.interactive) {
    const listed = await list();
    if (listed === undefined) return resolved();
    const keys = listed.map((x) => x.key);
    const initial = stored?.kind === 'team' ? stored.labels.filter((k) => keys.includes(k)) : stored?.kind === 'yours' ? [] : ctx.citedKeys().filter((k) => keys.includes(k));
    const message = confluence
      ? 'Which Confluence spaces should Align read? Pick at least one.'
      : `Which ${WHAT[source as keyof typeof WHAT]} should Align read everything from? Leave all unselected to read only your own issues.`;
    const picked = await ctx.prompts.multiselect(message, listed.map((x) => ({ value: x.key, label: `${x.key}  ${x.name}` })), initial, { required: confluence });
    if (confluence && (picked === null || picked.length === 0)) throw blocked((await resolveScope(source, deps, { foreground: true })).blocked!);
    if (picked === null) return resolved();
    return fromChoice(await chooseScope(deps, source, picked.length === 0 ? { scope: 'yours' } : { scope: 'team', values: picked }, tokens));
  }

  // A chosen scope (team OR yours) is kept; only a source never chosen for falls to the cited keys.
  if (stored !== null || confluence) return resolved();
  // Not interactive, nothing flagged, nothing stored: the keys this person's own decisions cite, if the token can see them (Decision 7).
  const cited = ctx.citedKeys();
  if (cited.length === 0) return resolved();
  const listed = await list();
  const seen = listed === undefined ? [] : cited.filter((k) => listed.some((x) => x.key === k));
  if (seen.length === 0) return resolved();
  return fromChoice(await chooseScope(deps, source, { scope: 'team', values: seen }, tokens));
}

/**
 * The connect loop's one call: decide the scope, fetch under it, and write the choice only once the fetch succeeded. A team read says
 * whose items it covered in the report, unless the fetcher already did (GitHub names the repo itself).
 */
export async function fetchUnderScope(
  source: { id: string; fetch: (tokens: Record<string, string>, window?: SyncWindow, opts?: FetchExtras) => Promise<CaptureFetchResult> },
  tokens: Record<string, string>,
  window: SyncWindow | undefined,
  ctx: ConnectScopeCtx,
  /** Starts the caller's spinner. Called AFTER the questions and notes (a spinner redraws and listens to the keyboard, which garbles a picker),
   *  and also before a refusal is thrown, so the caller's stop line has a spinner to stop. */
  startSpinner: () => void = () => {},
): Promise<CaptureFetchResult> {
  let decision: ScopeDecision;
  try { decision = await decideConnectScope(source.id, tokens, ctx); } catch (e) { startSpinner(); throw e; }
  startSpinner();
  const fetched = await source.fetch(tokens, window, decision.extras);
  decision.commit();
  if (decision.scope === 'team' && fetched.report.scopeNote === undefined) {
    fetched.report.scopeNote = `${decision.label}, as far as your token can see`;
  }
  return fetched;
}

/** The real prompts: a clack multiselect. A cancel is null. Tests inject their own. */
export function clackScopePrompts(): ScopePrompts {
  return {
    async multiselect(message, options, initial, o) {
      const answer = await p.multiselect({ message, options: options.map((x) => ({ value: x.value, label: x.label, ...(x.hint !== undefined ? { hint: x.hint } : {}) })), initialValues: initial, required: o.required, maxItems: 12 });
      return p.isCancel(answer) ? null : (answer as string[]);
    },
  };
}

/** The production wiring of `ConnectScopeCtx` for `align connect` and `align setup`: the real store, graph, folder, network and prompts. */
export function connectScopeCtx(o: { config: ReturnType<typeof createConfigStore>; dbPath: string | undefined; interactive: boolean; quiet: boolean; flags?: ScopeFlags }): ConnectScopeCtx {
  const dbPath = o.dbPath;
  return {
    deps: realScopeDeps(dbPath, { config: o.config }), interactive: o.interactive, quiet: o.quiet, flags: o.flags ?? {}, prompts: clackScopePrompts(),
    citedKeys: () => (dbPath === undefined ? [] : citedProjectKeys(dbPath)), say: (line) => p.log.info(line),
  };
}
