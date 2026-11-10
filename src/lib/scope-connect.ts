/**
 * L4: choosing a scope while a source is being connected (`align connect --source <x>`, `align setup`).
 *
 * `decideConnectScope` runs BEFORE the fetch and returns what to fetch under; `fetchUnderScope` is the one call the connect loop makes:
 * decide, fetch, and only then write the choice. A fetch that fails writes nothing, and the token is still saved by the caller only
 * after the fetch succeeded, so a first connect has no saved token yet: every check here uses the IN-FLIGHT fields.
 *
 * What it decides, in order (a flag always wins, and a flag is checked against what the token can see before anything is fetched):
 * - GitHub and GitLab: the folder's remote decides, with no question (resolveScope). A repo the token cannot see is yours, said so.
 * - Jira and Linear: a picker on a terminal, with "None, skip <Source> in this repo" first (preselected unless a name matches this repo or
 *   a choice was stored); otherwise the stored choice, else yours with how to widen. A list that cannot be read never blocks: yours, and the reason is said.
 * - Confluence: spaces, picked, flagged or stored. With none, refused with the command (there is no "yours" to fall back to).
 * - Zoom: only yours, and it says why. Slack, Notion and Teams already read all the token can see: nothing to say.
 *
 * The team-scope disclosure is printed here, before the fetch, once per source. `quiet` (`--json`) prints nothing and does not mark
 * it told, so the next foreground run still tells the person.
 */
import path from 'node:path';
import { askWithTimeout } from './confirm-timeout.js';
import * as p from '@clack/prompts';
import { STARTED_BY_AGENT_ENV } from './backfill-state.js';
import type { createConfigStore } from './config.js';
import type { CaptureFetchResult } from './fetchers/capture.js';
import { type ChangedBy, type Choice, chooseScope, commitScope, CONFLUENCE_NEEDS_SPACES, markTold, type ResolvedScope, resolveScope, type ScopeDeps, type SetInput } from './scope.js';
import { matchRepoNames } from './scope-repo-match.js';
import { citedProjectKeys } from './scope-defaults.js';
import { realScopeDeps, scopeRepoKey } from './scope-real.js';
import { listConfluenceSpaces, listConfluenceTopLevelPages, listJiraBoards, listJiraProjects, listLinearProjects, listLinearTeams, listNotionPages, ScopeLookupError } from './scope-choices.js';
import { describeTeamScope, disclosureText, fetchOptsFor, FIXED_SCOPES, type Narrowing, SCOPED_SOURCES, type ScopedSource } from './scope-values.js';
import { CAPTURE_SOURCES } from './capture-sources.js';
import type { FetchExtras, SyncWindow } from './since.js';

export interface ScopeFlags {
  scope?: string; repo?: string; projects?: string; teams?: string; gitlabProject?: string; spaces?: string;
  /** Narrow one Jira project to a board (id or exact name) or a JQL filter, or one Linear team to some of its projects. */
  board?: string; jql?: string; linearProjects?: string;
  /** Notion: read only these pages (ids). Confluence, with --spaces: read only the trees under these pages (ids). */
  notionPages?: string; confluencePages?: string;
  /** The `--since` the person actually gave, as the lower bound it read back to (null: `all`). Not a scope flag: it only sets a NEW scope row's window. */
  windowSince?: string | null;
}
export interface PickOption { value: string; label: string; hint?: string }
export interface ScopePrompts {
  /** The values the person chose, or null when they cancelled. */
  multiselect(message: string, options: PickOption[], initial: string[], o: { required: boolean }): Promise<string[] | null>;
  /** A yes/no question whose default is No. A cancel, or a closed stdin, is No. */
  confirm(message: string): Promise<boolean>;
  /** One answer from a list, starting on `initial`; null when cancelled. Absent: the second question (one board or project) is not asked. */
  select?(message: string, options: PickOption[], initial: string): Promise<string | null>;
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
  /** Ticket prefixes local decisions cite (scope-defaults.ts). No longer preselected: the graph spans every repo on the machine, so
   *  its citations say nothing about THIS repo. Kept on the context for callers that still pass it. */
  citedKeys(): string[];
  /** Names this repo goes by (its remote's repo name, its folder), to preselect a team, project or space that matches. Absent: none. */
  repoNames?(): string[];
  /** Is this folder in a git repo? Skip is chosen for a repo, so outside one it is not offered. Absent: yes. */
  inRepo?(): boolean;
  say(line: string): void;
}
export interface ScopeDecision {
  /** Handed to the source's fetch. */
  extras: FetchExtras;
  scope: 'yours' | 'team';
  label: string;
  /** The person chose to skip this source in this repo: nothing is fetched, and `commit` remembers it. */
  readonly skipped?: true;
  /** True when this is a team read the person could not be told about (quiet): the disclosure is still owed. */
  readonly disclosurePending?: boolean;
  /** Write the choice. Called once, after the fetch succeeded. */
  commit(): void;
}

/** The picker's "none" answer. Not a key any source can have (keys never start with a colon), so it cannot collide with a team. */
export const SKIP_VALUE = ':skip';

const labelOf = (source: string): string => (CAPTURE_SOURCES as Record<string, { label: string }>)[source]?.label ?? source;
const isScoped = (source: string): source is ScopedSource => (SCOPED_SOURCES as readonly string[]).includes(source);
const VALUE_FLAG = { github: 'repo', jira: 'projects', linear: 'teams', gitlab: 'gitlabProject', confluence: 'spaces', notion: 'notionPages' } as const;
const FLAG_NAME = { repo: '--repo', projects: '--projects', teams: '--teams', gitlabProject: '--gitlab-project', spaces: '--spaces', notionPages: '--notion-pages' } as const;
const FLAG_FOR = { repo: 'GitHub', projects: 'Jira', teams: 'Linear', gitlabProject: 'GitLab', spaces: 'Confluence', notionPages: 'Notion' } as const;
const WHAT = { jira: 'Jira projects', linear: 'Linear teams', confluence: 'Confluence spaces', notion: 'Notion pages' } as const;
/** What a narrowing flag's `needs` flag names, for "to say which ...". */
const NEEDS_WHAT = { projects: 'project', teams: 'team', spaces: 'space' } as const;
/** The flags that narrow one project or team, the source each belongs to, and the value flag each needs. */
const NARROW_FLAG = {
  board: { name: '--board', source: 'jira', needs: 'projects' },
  jql: { name: '--jql', source: 'jira', needs: 'projects' },
  linearProjects: { name: '--linear-projects', source: 'linear', needs: 'teams' },
  confluencePages: { name: '--confluence-pages', source: 'confluence', needs: 'spaces' },
} as const;

/** Checked before any prompt or request. Returns the sentence to print with exit 2, or undefined when the flags are usable. */
export function checkScopeFlags(source: string | undefined, flags: ScopeFlags): string | undefined {
  const valueFlags = (Object.keys(FLAG_NAME) as Array<keyof typeof FLAG_NAME>).filter((k) => flags[k] !== undefined);
  const narrowFlags = (Object.keys(NARROW_FLAG) as Array<keyof typeof NARROW_FLAG>).filter((k) => flags[k] !== undefined);
  if (flags.scope === undefined && valueFlags.length === 0 && narrowFlags.length === 0) return undefined;
  for (const k of narrowFlags) {
    const { name, source: owner, needs } = NARROW_FLAG[k];
    if (source !== owner) return `${name} is for ${labelOf(owner)}.`;
    if (flags.scope === 'yours') return `Pass either --scope yours or ${name}, not both.`;
    if (flags[needs] === undefined) return `${name} needs ${FLAG_NAME[needs]}, to say which ${NEEDS_WHAT[needs]} it narrows.`;
  }
  if (source === undefined) return 'Scope flags (--scope, --repo, --projects, --teams, --gitlab-project, --spaces) need --source <id> to say which source they are for.';
  const fixed = FIXED_SCOPES[source];
  if (fixed && !isScoped(source)) return `${labelOf(source)} reads ${fixed.text}. There is no scope to choose for it.`;
  if (!isScoped(source)) return 'That source has no scope to choose.';
  if (flags.scope !== undefined && flags.scope !== 'yours' && flags.scope !== 'team') return '--scope takes yours or team.';
  const wrong = valueFlags.find((k) => VALUE_FLAG[source] !== k);
  if (wrong !== undefined) return `${FLAG_NAME[wrong]} is for ${FLAG_FOR[wrong]}; ${labelOf(source)} takes ${FLAG_NAME[VALUE_FLAG[source]]}.`;
  const given = valueFlags.length > 0;
  if (flags.scope === 'yours' && given) return `Pass either --scope yours or ${FLAG_NAME[VALUE_FLAG[source]]}, not both.`;
  if (flags.scope === 'team' && !given && source !== 'github' && source !== 'gitlab') return `--scope team needs ${FLAG_NAME[VALUE_FLAG[source]]} to say which ${source === 'confluence' ? 'spaces' : source === 'jira' ? 'projects' : source === 'notion' ? 'pages' : 'teams'}.`;
  return undefined;
}

function flagInput(source: ScopedSource, flags: ScopeFlags): SetInput | undefined {
  if (flags.scope === 'yours') return { scope: 'yours' };
  const value = flags[VALUE_FLAG[source]];
  if (value === undefined) return undefined;
  const narrow = { ...(flags.board !== undefined ? { board: flags.board } : {}), ...(flags.jql !== undefined ? { jql: flags.jql } : {}), ...(flags.linearProjects !== undefined ? { projects: flags.linearProjects } : {}), ...(flags.confluencePages !== undefined ? { ancestors: flags.confluencePages } : {}) };
  return { scope: 'team', values: value, ...(Object.keys(narrow).length > 0 ? { narrow } : {}) };
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
  const skipDecision = (commit: () => void): ScopeDecision =>
    ({ extras: { resolved: true }, scope: 'yours', label: `nothing (${labelOf(source)} is skipped in this repo)`, skipped: true, commit });
  const decision = (extras: FetchExtras, scope: 'yours' | 'team', label: string, commit: () => void): ScopeDecision =>
    ({ extras, scope, label, get disclosurePending() { return disclosurePending; }, commit });
  const fromChoice = (c: Choice): ScopeDecision => {
    if (c.scope === 'team') told(c.scopeKey, disclosureText(source, c.labels, c.narrow));
    const extras: FetchExtras = c.scope === 'yours'
      ? { resolved: true }
      : { resolved: true, ...(source === 'github' ? { repo: c.values[0]!, team: true } : fetchOptsFor(source, c.values, c.narrow)) };
    return decision(extras, c.scope, c.label, () => { commitScope(deps, source, c, by, ctx.flags.windowSince); });
  };
  /** What is in force without the agent's waiting choice: the same answer a background run gets. */
  const kept = (): Promise<ResolvedScope> => resolveScope(source, { ...deps, isTty: () => false }, { foreground: false });
  const fromResolved = async (r: ResolvedScope, o: { note?: boolean } = {}): Promise<ScopeDecision> => {
    if (r.blocked !== undefined) throw blocked(r.blocked);
    if (r.skipped !== undefined) return skipDecision(() => {});
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
  if (source === 'notion') return pickNotionPages();

  const listed = await list();
  if (listed === undefined) return resolved();
  const keys = listed.map((x) => x.key);
  const waitingLabels = stored?.kind === 'team' && stored.pending ? stored.labels : [];
  const inForce = stored?.kind === 'team' && stored.pending ? stored.pending.previous : stored;
  // What is preselected is what is already in force, or what local decisions cite. An agent's WAITING choice is never preselected:
  // it is said, and picking it here is the explicit confirmation.
  if (waitingLabels.length > 0) tell(`Your agent proposed ${source} scope ${describeTeamScope(source, waitingLabels, stored?.kind === 'team' ? stored.narrow : undefined)}. It is not read until you pick it here.`);
  // Preselected: what is already in force; else what matches this repo by name; else skip, because a team that has nothing to do with
  // this repo would put its whole history into this repo's graph (a fastify clone read 2,000 Align tickets).
  const inRepo = ctx.inRepo?.() ?? true;
  const matched = matchRepoNames(listed, ctx.repoNames?.() ?? []);
  const initial = inForce?.kind === 'team' ? inForce.labels.filter((k) => keys.includes(k))
    : inForce?.kind === 'skip' ? [SKIP_VALUE]
    : inForce?.kind === 'yours' ? []
    : matched.length > 0 ? matched : inRepo ? [SKIP_VALUE] : [];
  const message = confluence
    ? 'Which Confluence spaces should Align read? Pick at least one.'
    : `Which ${WHAT[source as keyof typeof WHAT]} should Align read everything from? Leave all unselected to read only the items you are involved in.`;
  const picked = await ctx.prompts.multiselect(message, [...(inRepo ? [{ value: SKIP_VALUE, label: `None, skip ${labelOf(source)} in this repo` }] : []), ...listed.map((x) => ({ value: x.key, label: `${x.key}  ${x.name}` }))], initial, { required: confluence });
  // Cancelled: nothing changes, and an agent's waiting scope stays waiting (it is not promoted, and not read).
  if (picked === null) {
    const k = await kept();
    if (k.blocked !== undefined) throw blocked(k.blocked);
    return fromResolved(k);
  }
  // Skip wins over anything ticked beside it: reading nothing is the narrower answer.
  if (picked.includes(SKIP_VALUE) && !inRepo) throw blocked('Skipping a source is chosen for one repo, and this folder is not in a git repo. Pick a team, or none to read only your own items.');
  if (picked.includes(SKIP_VALUE)) return skipDecision(() => { deps.store.saveScope(source, { kind: 'skip' }); });
  if (confluence && picked.length === 0) throw blocked(CONFLUENCE_NEEDS_SPACES);
  const choice = await chooseScope(deps, source, picked.length === 0 ? { scope: 'yours' } : { scope: 'team', values: picked }, tokens);
  if (choice.scope === 'team' && choice.values.length === 1 && (source === 'jira' || source === 'linear') && ctx.prompts.select) {
    const narrowed = await askForPart(source, choice.values[0]!, choice.labels[0]!, inForce?.kind === 'team' ? inForce.narrow : undefined);
    if (narrowed !== undefined) return fromChoice(await chooseScope(deps, source, { scope: 'team', values: picked, narrow: narrowed }, tokens));
  }
  if (choice.scope === 'team' && confluence) {
    const narrowed = await askForConfluencePages(choice.values, inForce?.kind === 'team' ? inForce.narrow : undefined);
    if (narrowed !== undefined) return fromChoice(await chooseScope(deps, source, { scope: 'team', values: picked, narrow: narrowed }, tokens));
  }
  return fromChoice(choice);

  /**
   * Notion has no list of named places like Jira's: it reads what the integration was shared. So the picker lists the pages and
   * databases it can see, and nothing ticked keeps that (today's read). Pages whose title shares a whole word with this repo are preselected.
   */
  async function pickNotionPages(): Promise<ScopeDecision> {
    let listed: Awaited<ReturnType<typeof listNotionPages>>;
    try { listed = await listNotionPages(tokens, deps.fetch); } catch (e) {
      if (!(e instanceof ScopeLookupError)) throw e;
      tell(`Could not list your Notion pages: ${e.message} Reading everything shared with your integration.`);
      return resolved();
    }
    if (listed.truncated) tell(`Only the ${listed.items.length} most recently edited Notion pages are listed. To pick one that is not shown: align connect --source notion --notion-pages IDS`);
    const ids = listed.items.map((x) => x.id);
    const before = stored?.kind === 'team' && stored.pending ? stored.pending.previous : stored;
    const waiting = stored?.kind === 'team' && stored.pending ? stored : undefined;
    if (waiting) tell(`Your agent proposed Notion scope ${describeTeamScope('notion', waiting.labels, waiting.narrow)}. It is not read until you pick it here.`);
    const inRepo = ctx.inRepo?.() ?? true;
    const matched = matchRepoNames(listed.items.map((x) => ({ key: x.id, name: x.name })), ctx.repoNames?.() ?? []);
    // No match preselects nothing: Enter keeps reading everything shared, as before this question existed.
    // Nothing stored: nothing preselected, so Enter keeps reading everything shared. Matching pages are listed first instead.
    const initial = before?.kind === 'team' ? before.values.filter((v) => ids.includes(v)) : before?.kind === 'skip' ? [SKIP_VALUE] : [];
    const ordered = [...listed.items.filter((x) => matched.includes(x.id)), ...listed.items.filter((x) => !matched.includes(x.id))];
    const picked = await ctx.prompts.multiselect(
      'Which Notion pages should Align read, with the pages under them? Pick none to read everything shared with your integration.',
      [...(inRepo ? [{ value: SKIP_VALUE, label: `None, skip ${labelOf('notion')} in this repo` }] : []), ...ordered.map((x) => ({ value: x.id, label: x.name, hint: x.kind }))],
      initial, { required: false },
    );
    if (picked === null) {
      const k = await kept();
      if (k.blocked !== undefined) throw blocked(k.blocked);
      return fromResolved(k);
    }
    if (picked.includes(SKIP_VALUE) && !inRepo) throw blocked('Skipping a source is chosen for one repo, and this folder is not in a git repo. Pick pages, or none to read everything shared with your integration.');
    if (picked.includes(SKIP_VALUE)) return skipDecision(() => { deps.store.saveScope(source, { kind: 'skip' }); });
    return fromChoice(await chooseScope(deps, source, picked.length === 0 ? { scope: 'yours' } : { scope: 'team', values: picked }, tokens));
  }

  /**
   * "Read the whole space, or only under some pages?" asked after Confluence spaces were chosen. The whole space is first and where the
   * cursor starts, unless pages were chosen before. Undefined: the whole space (today's read). A list that cannot be read is said.
   */
  async function askForConfluencePages(spaces: string[], before: Narrowing | undefined): Promise<{ ancestors: string[] } | undefined> {
    let parts: Array<{ id: string; name: string }>;
    try { parts = (await listConfluenceTopLevelPages(tokens, spaces, deps.fetch)).items; } catch (e) {
      if (!(e instanceof ScopeLookupError)) throw e;
      tell(`Could not list the pages in ${spaces.join(', ')}: ${e.message} Reading the whole ${spaces.length === 1 ? 'space' : 'spaces'}.`);
      return undefined;
    }
    if (parts.length === 0) return undefined;
    const ALL = ':all';
    const earlier = before?.by === 'ancestors' ? before.ids.filter((id) => parts.some((x) => x.id === id)) : [];
    const picks = await ctx.prompts.multiselect(
      `Which pages of ${spaces.join(', ')} should Align read, with the pages under them? Or the whole ${spaces.length === 1 ? 'space' : 'spaces'}.`,
      [{ value: ALL, label: `The whole ${spaces.length === 1 ? 'space' : 'spaces'} ${spaces.join(', ')}` }, ...parts.map((x) => ({ value: x.id, label: x.name }))],
      earlier.length > 0 ? earlier : [ALL], { required: false },
    );
    if (picks === null || picks.includes(ALL) || picks.length === 0) return undefined;
    return { ancestors: picks };
  }

  /**
   * "Read all of AC, or one board?" (Linear: one project). All of it is first and where the cursor starts, unless a part was
   * chosen before. Undefined: read all of it. A list that cannot be read is said, and all of it is read.
   */
  async function askForPart(src: 'jira' | 'linear', value: string, label: string, before: Narrowing | undefined): Promise<{ board: string } | { projects: string[] } | undefined> {
    const what = src === 'jira' ? 'board' : 'project';
    let parts: Array<{ id: string; name: string }>;
    try {
      parts = (src === 'jira' ? await listJiraBoards(tokens, value, deps.fetch) : await listLinearProjects(tokens, value, deps.fetch)).items;
    } catch (e) {
      if (!(e instanceof ScopeLookupError)) throw e;
      tell(`Could not list the ${what}s in ${label}: ${e.message} Reading all of ${label}.`);
      return undefined;
    }
    if (parts.length === 0) return undefined;
    const ALL = ':all';
    const named = matchRepoNames(parts.map((x) => ({ key: x.name, name: x.name })), ctx.repoNames?.() ?? []);
    if (src === 'linear') {
      // Linear: several projects of the team. The whole team is first; the cursor starts on what was chosen before, else on the
      // project named like this repo, else on the whole team. The whole team beats projects ticked beside it (the wider read is
      // what a person who ticked it asked for), and nothing ticked or a cancel reads it too: today's behaviour.
      const earlier = before?.by === 'projects' ? before.ids.filter((id) => parts.some((x) => x.id === id)) : [];
      const byName = named.length === 1 ? parts.filter((x) => x.name === named[0]).map((x) => x.id) : [];
      const initial = earlier.length > 0 ? earlier : byName.length > 0 ? byName : [ALL];
      const picks = await ctx.prompts.multiselect(`Which projects of ${label} should Align read? Or the whole team.`, [{ value: ALL, label: `The whole team ${label}` }, ...parts.map((x) => ({ value: x.id, label: x.name }))], initial, { required: false });
      if (picks === null || picks.includes(ALL) || picks.length === 0) return undefined;
      return { projects: picks };
    }
    const previous = before?.by === 'board' ? before.id : undefined;
    // The cursor starts on what was chosen before; else on the one board named like this repo; else on all of it.
    const byName = named.length === 1 ? parts.find((x) => x.name === named[0]) : undefined;
    const initial = previous !== undefined && parts.some((x) => x.id === previous) ? previous : byName?.id ?? ALL;
    const answer = await ctx.prompts.select!(`Read all of ${label}, or one ${what}?`, [{ value: ALL, label: `All of ${label}` }, ...parts.map((x) => ({ value: x.id, label: x.name }))], initial);
    if (answer === null || answer === ALL) return undefined;
    return { board: answer };
  }
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
  return fetchWithDecision(source, tokens, window, decision, startSpinner);
}

/** Fetch under a scope already decided (and asked about), then write it. The fetch half of fetchUnderScope. */
export async function fetchWithDecision(
  source: { id: string; fetch: (tokens: Record<string, string>, window?: SyncWindow, opts?: FetchExtras) => Promise<CaptureFetchResult> },
  tokens: Record<string, string>,
  window: SyncWindow | undefined,
  decision: ScopeDecision,
  startSpinner: () => void = () => {},
): Promise<CaptureFetchResult> {
  // Skipped here: nothing is read, and the choice is remembered for this repo.
  if (decision.skipped) {
    decision.commit();
    return { items: [], report: { scanned: 0, skips: [], skippedInRepo: true } };
  }
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
    /** One choice from a list, with the cursor on `initial`; null when the person cancels. */
    async select(message, options, initial) {
      const answer = await p.select({ message, options: options.map((x) => ({ value: x.value, label: x.label })), initialValue: initial, maxItems: 12 });
      return p.isCancel(answer) ? null : String(answer);
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

/** What this repo is called: the last part of its identity (`github.com/o/fastify` is `fastify`) and the folder it is in. */
function repoNamesHere(): string[] {
  const id = scopeRepoKey();
  const names = [path.basename(process.cwd())];
  if (id !== null) names.push(path.basename(id));
  return [...new Set(names.filter((n) => n !== ''))];
}

/** The production wiring of `ConnectScopeCtx` for `align connect` and `align setup`: the real store, graph, folder, network and prompts. */
export function connectScopeCtx(o: { config: ReturnType<typeof createConfigStore>; dbPath: string | undefined; interactive: boolean; quiet: boolean; flags?: ScopeFlags }): ConnectScopeCtx {
  const dbPath = o.dbPath;
  return {
    deps: realScopeDeps(dbPath, { config: o.config }), interactive: o.interactive, quiet: o.quiet, flags: o.flags ?? {}, prompts: clackScopePrompts(),
    ...(startedByAgent() ? { by: { via: 'mcp' as const, agent: 'unknown' } } : {}),
    citedKeys: () => (dbPath === undefined ? [] : citedProjectKeys(dbPath)), repoNames: repoNamesHere, inRepo: () => scopeRepoKey() !== null, say: (line) => p.log.info(line),
  };
}
