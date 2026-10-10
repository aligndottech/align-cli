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
import { askWithTimeout } from './confirm-timeout.js';
import * as p from '@clack/prompts';
import { STARTED_BY_AGENT_ENV } from './backfill-state.js';
import type { createConfigStore } from './config.js';
import type { CaptureFetchResult } from './fetchers/capture.js';
import { type ChangedBy, type Choice, chooseScope, commitScope, CONFLUENCE_NEEDS_SPACES, markTold, type ResolvedScope, resolveScope, type ScopeDeps, type SetInput } from './scope.js';
import { citedProjectKeys } from './scope-defaults.js';
import { realScopeDeps } from './scope-real.js';
import { listConfluenceSpaces, listJiraProjects, listLinearTeams, ScopeLookupError } from './scope-choices.js';
import { describeScopeKey, disclosureText, fetchOptsFor, FIXED_SCOPES, SCOPED_SOURCES, type ScopedSource, scopeKeyOf } from './scope-values.js';
import { CAPTURE_SOURCES } from './capture-sources.js';
import type { FetchExtras, SyncWindow } from './since.js';

export interface ScopeFlags {
  scope?: string; repo?: string; projects?: string; teams?: string; gitlabProject?: string; spaces?: string;
  /** The `--since` the person actually gave, as the lower bound it read back to (null: `all`). Not a scope flag: it only sets a NEW scope row's window. */
  windowSince?: string | null;
}
export interface PickOption { value: string; label: string; hint?: string }
export interface ScopePrompts {
  /** The values the person chose, or null when they cancelled. */
  multiselect(message: string, options: PickOption[], initial: string[], o: { required: boolean }): Promise<string[] | null>;
  /** A yes/no question whose default is No. A cancel, or a closed stdin, is No. */
  confirm(message: string): Promise<boolean>;
}
export interface ConnectScopeCtx {
  /** The store, graph and network the scope code uses. `store.fields` is overlaid with the in-flight fields per source. */
  deps: ScopeDeps;
  interactive: boolean;
  /** `--json`: print nothing, and do not mark the disclosure told. */
  quiet: boolean;
  flags: ScopeFlags;
  prompts: ScopePrompts;
  /** Who the choices are attributed to. Absent: the person at this command line. A child `align_backfill` started is an agent's: its choices wait. */
  by?: ChangedBy;
  /** Ticket prefixes local decisions cite (scope-defaults.ts), to preselect. */
  citedKeys(): string[];
  say(line: string): void;
}
export interface ScopeDecision {
  /** Handed to the source's fetch. */
  extras: FetchExtras;
  scope: 'yours' | 'team';
  label: string;
  /** True when this is a team read the person could not be told about (quiet): the disclosure is still owed. */
  readonly disclosurePending?: boolean;
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

type Lister = (tokens: Record<string, string>, f: ScopeDeps['fetch'], o: { max?: number }) => Promise<{ items: Array<{ key: string; name: string }>; truncated: boolean }>;
const LISTERS: Partial<Record<ScopedSource, Lister>> = {
  jira: listJiraProjects,
  confluence: listConfluenceSpaces,
  linear: async (t, f) => { const r = await listLinearTeams(t, f); return { items: r.items.map(({ key, name }) => ({ key, name })), truncated: r.truncated }; },
};

/** Decide the scope of one source being connected, with the in-flight `tokens`. May print (disclosure, notes). Throws to refuse. */
export async function decideConnectScope(source: string, tokens: Record<string, string>, ctx: ConnectScopeCtx): Promise<ScopeDecision> {
  const tell = (line: string): void => { if (!ctx.quiet) ctx.say(line); };
  const fixed = FIXED_SCOPES[source];
  if (!isScoped(source)) {
    if (source === 'zoom' && fixed) tell(`${labelOf(source)} reads ${fixed.text}.`);
    return { extras: {}, scope: 'yours', label: 'your own items', commit() {} };
  }
  // A person is someone at a terminal who can be shown the disclosure and asked: a TTY, and not --json. Everything else (a script, an agent's
  // shell, a child `align_backfill` started) is UNATTENDED: it reads yours, it never widens from the folder or from cited keys, and a
  // widening it is asked for is saved as PENDING for a person to confirm.
  const person = ctx.interactive && !ctx.quiet;
  // The store, with this source's fields replaced by the ones in hand: a first connect has nothing saved to read.
  const deps: ScopeDeps = { ...ctx.deps, isTty: () => person, store: { ...ctx.deps.store, fields: (s) => (s === source ? tokens : ctx.deps.store.fields(s)) } };
  const by: ChangedBy = ctx.by ?? { via: 'cli', unattended: !person };
  // A team read whose disclosure could not be shown (--json): the result says so, and it stays un-marked for the next foreground run.
  let disclosurePending = false;
  const blocked = (reason: string): Error => new Error(reason);

  const told = (scopeKey: string, text: string): void => {
    if (deps.store.isDisclosed(source, scopeKey)) return;
    if (ctx.quiet) { disclosurePending = true; return; }
    tell(text);
    markTold(deps.store, source, scopeKey);
  };
  const decision = (extras: FetchExtras, scope: 'yours' | 'team', label: string, commit: () => void): ScopeDecision =>
    ({ extras, scope, label, get disclosurePending() { return disclosurePending; }, commit });
  const fromChoice = (c: Choice): ScopeDecision => {
    if (c.scope === 'team') told(c.scopeKey, disclosureText(source, c.labels));
    const extras: FetchExtras = c.scope === 'yours'
      ? { resolved: true }
      : { resolved: true, ...(source === 'github' ? { repo: c.values[0]!, team: true } : fetchOptsFor(source, c.values)) };
    return decision(extras, c.scope, c.label, () => { commitScope(deps, source, c, by, ctx.flags.windowSince); });
  };
  /** What is in force without the agent's waiting choice: the same answer a background run gets. */
  const kept = (): Promise<ResolvedScope> => resolveScope(source, { ...deps, isTty: () => false }, { foreground: false });
  const fromResolved = async (r: ResolvedScope, o: { note?: boolean } = {}): Promise<ScopeDecision> => {
    if (r.blocked !== undefined) throw blocked(r.blocked);
    if (r.activates) {
      // An agent's waiting scope, offered to a person: the disclosure every time, and only an explicit Yes makes it active.
      tell(r.disclosure!);
      const yes = await ctx.prompts.confirm(`Read ${r.label} now? No keeps your current scope.`);
      if (!yes) return fromResolved(await kept());
      markTold(deps.store, source, r.scopeKey);
    } else if (r.disclosure !== undefined) told(r.scopeKey, r.disclosure);
    if (r.note !== undefined && o.note !== false) tell(r.note);
    // A team scope read with nobody to tell (--json, no terminal) that was never told for this scope: the disclosure is still owed.
    if (r.scope === 'team' && !person && !deps.store.isDisclosed(source, r.scopeKey)) disclosurePending = true;
    return decision({ resolved: true, ...(r.repo ? { repo: r.repo, team: true } : {}), ...r.extras }, r.scope, r.label, () => {});
  };
  const resolved = async (o: { note?: boolean } = {}): Promise<ScopeDecision> => fromResolved(await resolveScope(source, deps, { foreground: true }), o);
  const list = async (): Promise<Array<{ key: string; name: string }> | undefined> => {
    try {
      const r = await LISTERS[source]!(tokens, deps.fetch, deps.listMax !== undefined ? { max: deps.listMax } : {});
      if (r.truncated) tell(`Only the first ${r.items.length} ${WHAT[source as keyof typeof WHAT]} are listed. To pick one that is not shown: align connect --source ${source} ${source === 'jira' ? '--projects' : source === 'linear' ? '--teams' : '--spaces'} KEYS`);
      return r.items;
    } catch (e) {
      if (!(e instanceof ScopeLookupError)) throw e;
      if (source === 'confluence') throw blocked(`${e.message} Confluence reads only the spaces you choose, so nothing was read. Pick them: align connect --source confluence --spaces ENG,OPS`);
      tell(`Could not list your ${WHAT[source as keyof typeof WHAT]}: ${e.message}`);
      return undefined;
    }
  };

  const input = flagInput(source, ctx.flags);
  if (input) {
    const c = await chooseScope(deps, source, input, tokens);
    if (c.scope === 'yours' || person) return fromChoice(c);
    // Unattended widening: read what is in force now, and save the request for a person to confirm at a terminal.
    let k: ScopeDecision;
    // One line for the person, not two: the "will read ... once you confirm" line below replaces the default scope's own hint.
    try { k = await resolved({ note: false }); } catch (e) {
      // Confluence with nothing chosen yet: the request is still saved for the person, and the refusal says so.
      commitScope(deps, source, c, by, ctx.flags.windowSince);
      throw new Error(`${(e as Error).message} Your request for ${c.label} is saved and waiting for you to confirm: run \`align sync ${source}\` at a terminal.`);
    }
    tell(`${labelOf(source)} will read ${c.label} once you confirm it: run \`align sync ${source}\` at a terminal (it will show what it reads).`);
    return decision(k.extras, k.scope, k.label, () => { commitScope(deps, source, c, by, ctx.flags.windowSince); });
  }

  if (source === 'github' || source === 'gitlab') {
    const d = await resolved();
    if (ctx.flags.scope === 'team' && d.scope === 'yours') {
      throw blocked(`--scope team needs a ${source === 'github' ? 'repo' : 'project'}: this folder is not one. Pass ${source === 'github' ? '--repo owner/repo' : '--gitlab-project group/project'}.`);
    }
    return d;
  }

  const stored = deps.store.getScope(source);
  const confluence = source === 'confluence';
  // Without a person there is no picker and no guess from cited keys: the stored choice, else yours (with how to widen).
  if (!person) return resolved();

  const listed = await list();
  if (listed === undefined) return resolved();
  const keys = listed.map((x) => x.key);
  const waitingLabels = stored?.kind === 'team' && stored.pending ? stored.labels : [];
  const inForce = stored?.kind === 'team' && stored.pending ? stored.pending.previous : stored;
  // What is preselected is what is already in force, or what local decisions cite. An agent's WAITING choice is never preselected:
  // it is said, and picking it here is the explicit confirmation.
  if (waitingLabels.length > 0) tell(`Your agent proposed ${source} scope ${describeScopeKey(source, scopeKeyOf(source, waitingLabels), 'team')}. It is not read until you pick it here.`);
  const initial = inForce?.kind === 'team' ? inForce.labels.filter((k) => keys.includes(k)) : inForce?.kind === 'yours' ? [] : ctx.citedKeys().filter((k) => keys.includes(k));
  const message = confluence
    ? 'Which Confluence spaces should Align read? Pick at least one.'
    : `Which ${WHAT[source as keyof typeof WHAT]} should Align read everything from? Leave all unselected to read only the items you are involved in.`;
  const picked = await ctx.prompts.multiselect(message, listed.map((x) => ({ value: x.key, label: `${x.key}  ${x.name}` })), initial, { required: confluence });
  // Cancelled: nothing changes, and an agent's waiting scope stays waiting (it is not promoted, and not read).
  if (picked === null) {
    const k = await kept();
    if (k.blocked !== undefined) throw blocked(k.blocked);
    return fromResolved(k);
  }
  if (confluence && picked.length === 0) throw blocked(CONFLUENCE_NEEDS_SPACES);
  return fromChoice(await chooseScope(deps, source, picked.length === 0 ? { scope: 'yours' } : { scope: 'team', values: picked }, tokens));
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
  // A copy, never an edit of what the fetcher returned.
  const report = { ...fetched.report };
  if (decision.scope === 'team' && report.scopeNote === undefined) report.scopeNote = `${decision.label}, as far as your token can see`;
  if (decision.disclosurePending) report.disclosurePending = true;
  return { ...fetched, report };
}

/** The real prompts: a clack multiselect. A cancel is null. Tests inject their own. */
export function clackScopePrompts(): ScopePrompts {
  return {
    async multiselect(message, options, initial, o) {
      const answer = await p.multiselect({ message, options: options.map((x) => ({ value: x.value, label: x.label, ...(x.hint !== undefined ? { hint: x.hint } : {}) })), initialValues: initial, required: o.required, maxItems: 12 });
      return p.isCancel(answer) ? null : (answer as string[]);
    },
    async confirm(message) {
      return askWithTimeout(async () => (await p.confirm({ message, initialValue: false })) === true);
    },
  };
}

/**
 * Was this process started by an agent's tool call (`align_backfill`, `align_sync run`)? Those children carry the marker, so any scope
 * they would write is attributed to the agent and waits for a person, exactly like `align_scope set`.
 */
export function startedByAgent(env: Record<string, string | undefined> = process.env): boolean {
  return env[STARTED_BY_AGENT_ENV] === 'mcp';
}

/** The production wiring of `ConnectScopeCtx` for `align connect` and `align setup`: the real store, graph, folder, network and prompts. */
export function connectScopeCtx(o: { config: ReturnType<typeof createConfigStore>; dbPath: string | undefined; interactive: boolean; quiet: boolean; flags?: ScopeFlags }): ConnectScopeCtx {
  const dbPath = o.dbPath;
  return {
    deps: realScopeDeps(dbPath, { config: o.config }), interactive: o.interactive, quiet: o.quiet, flags: o.flags ?? {}, prompts: clackScopePrompts(),
    ...(startedByAgent() ? { by: { via: 'mcp' as const, agent: 'unknown' } } : {}),
    citedKeys: () => (dbPath === undefined ? [] : citedProjectKeys(dbPath)), say: (line) => p.log.info(line),
  };
}
