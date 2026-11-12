import { listJiraProjects, listLinearTeams, ScopeLookupError } from '../scope-choices.js';
import { getEntry, type LedgerEntry, ledgerKey, LockedError, type PlannedTask, putEntry, withLock } from './ledger.js';
import type { SavedTarget } from './targets.js';
import { parseTasks, type ShapeResult } from './shape.js';
import {
  CannotCreateError, type CreatedIssue, createGithubIssue, createJiraIssue, createLinearIssue, isJiraProject, isRepo, linearWorkspace, MaybeCreatedError,
  resolveLinearTeamId, TRACKER_LABEL, type TrackerId, TRACKERS,
} from './trackers.js';

export interface DecisionInput { id: string; title: string; summary: string; sourceUrl?: string | null; actions: string[] }

export interface BacklogOptions {
  /** A decision id, or search words. */
  decision: string;
  tracker?: string;
  team?: string; repo?: string; project?: string;
  /** Overrides the saved credential's token. */
  token?: string;
  dryRun?: boolean;
  /** Create again even though this decision was already turned into issues here. */
  force?: boolean;
  max?: number;
  /** The caller cannot be asked (the MCP tool): an ambiguity comes back as a NeedsChoice carrying the options, never a failure. */
  structuredChoices?: boolean;
}

export interface BacklogDeps {
  getDecision(id: string): Promise<DecisionInput>;
  search(q: string): Promise<DecisionInput[]>;
  shape(d: DecisionInput, max: number): Promise<ShapeResult>;
  /** The saved credential fields for a tracker (token, plus email/domain for Jira), or null. */
  credentials(tracker: TrackerId): Record<string, string> | null;
  fetch: typeof fetch;
  ledgerPath: string;
  interactive: boolean;
  choose(question: string, options: Array<{ value: string; label: string }>): Promise<string | null>;
  /** A link a person can open for this decision, or null when there is none (a local graph has no web page). */
  decisionUrl(id: string): string | null;
  /** This repo's saved destination, if a run has already created issues here. Absent in a caller that keeps none. */
  savedTarget?(): SavedTarget | undefined;
  saveTarget?(t: SavedTarget): void;
  out(line: string): void;
  err(line: string): void;
}

export const DEFAULT_MAX_TASKS = 8;
const ID_SHAPE = /^[0-9a-f][0-9a-f-]{6,}$/i;
const ID_HINT = 'Pass the decision id (align decisions list) to choose one.';

export class Stop extends Error { constructor(readonly code: number, message: string) { super(message); } }

export type ChoiceField = 'decision' | 'tracker' | 'team' | 'repo' | 'project';
export interface Choice { field: ChoiceField; question: string; options: Array<{ value: string; label: string }> }
/** An ambiguity a person at a terminal is asked about. For a caller that cannot be asked it carries the question as data; the message is the CLI's. */
export class NeedsChoice extends Stop { constructor(message: string, readonly choice: Choice) { super(2, message); } }

/** Exit 2 with the CLI's own wording; for a structured caller the same stop also carries the question and its options. */
async function ambiguous(o: BacklogOptions, message: string, choice: () => Promise<Choice>): Promise<never> {
  throw o.structuredChoices ? new NeedsChoice(message, await choice()) : new Stop(2, message);
}

async function pickDecision(o: BacklogOptions, d: BacklogDeps): Promise<DecisionInput> {
  if (ID_SHAPE.test(o.decision)) {
    try { return await d.getDecision(o.decision); } catch (e) {
      // A word that happens to look like an id is still searchable; only a miss on a real lookup falls through.
      if (!/not found|404/i.test((e as Error).message)) throw new Stop(1, `Could not read that decision: ${(e as Error).message}`);
    }
  }
  const noTerminal = `"${o.decision}" is not a decision id and there is no terminal to confirm a search match. ${ID_HINT}`;
  // A structured caller shows the plan, with this decision's title, before anything is created: that is its confirmation.
  if (!d.interactive && !o.structuredChoices) throw new Stop(2, noTerminal);
  const hits = await d.search(o.decision);
  if (hits.length === 0) throw new Stop(1, `No decision matches "${o.decision}".`);
  if (hits.length === 1) return hits[0]!;
  const options = hits.slice(0, 8).map((h) => ({ value: h.id, label: h.title }));
  if (!d.interactive) return ambiguous(o, noTerminal, async () => ({ field: 'decision', question: 'Which decision?', options }));
  const id = await d.choose('Which decision?', options);
  const hit = hits.find((h) => h.id === id);
  if (!hit) throw new Stop(1, 'No decision chosen.');
  return hit;
}

async function pickTracker(o: BacklogOptions, d: BacklogDeps): Promise<TrackerId> {
  if (o.tracker !== undefined) {
    const t = TRACKERS.find((x) => x === o.tracker);
    if (!t) throw new Stop(2, `Unknown tracker "${o.tracker}". Use one of: ${TRACKERS.join(', ')}.`);
    return t;
  }
  const have = TRACKERS.filter((t) => d.credentials(t) !== null);
  // The tracker this repo's backlog already went to, unless its credential is gone: a saved name is a hint, never a permission.
  const saved = d.savedTarget?.();
  if (saved && have.includes(saved.tracker)) return saved.tracker;
  if (have.length === 1) return have[0]!;
  if (have.length === 0) throw new Stop(1, `No tracker connected. Run: align connect linear (or github, jira), or pass --tracker with --token.`);
  const options = have.map((t) => ({ value: t, label: TRACKER_LABEL[t] }));
  if (!d.interactive) return ambiguous(o, `More than one tracker is connected (${have.join(', ')}). Pass --tracker <${have.join('|')}>.`, async () => ({ field: 'tracker', question: 'Which tracker should the issues go to?', options }));
  const v = await d.choose('Which tracker?', options);
  if (!v || !have.some((t) => t === v)) throw new Stop(1, 'No tracker chosen.');
  return v as TrackerId;
}

/** The destination, as a short name for the plan and the ledger. Never guessed: a flag, this repo's saved one, a one-item list, or one question. */
async function pickTarget(t: TrackerId, o: BacklogOptions, fields: Record<string, string>, d: BacklogDeps): Promise<{ target: string; usedSaved: boolean }> {
  const need = (flag: string, what: string) => new Stop(2, `Say where the issues go: pass ${flag} ${what}.`);
  const flag = t === 'github' ? o.repo : t === 'linear' ? o.team : o.project;
  const saved = d.savedTarget?.();
  if (flag === undefined && saved && saved.tracker === t) return { target: saved.target, usedSaved: true };
  const flagName = t === 'github' ? '--repo' : t === 'linear' ? '--team' : '--project';
  if (t === 'github') {
    let repo = o.repo;
    if (repo === undefined) {
      const msg = need('--repo', '<owner/repo>').message;
      if (!d.interactive) return ambiguous(o, msg, async () => ({ field: 'repo', question: 'Which GitHub repository (owner/repo) should the issues go to?', options: [] }));
      const v = await d.choose('Which repository (owner/repo)?', []);
      if (!v) throw need('--repo', '<owner/repo>');
      repo = v;
    }
    if (!isRepo(repo)) throw new Stop(2, `"${repo}" is not an owner/repo name.`);
    return { target: repo, usedSaved: false };
  }
  if (flag !== undefined) {
    if (t === 'jira' && !isJiraProject(flag)) throw new Stop(2, `"${flag}" is not a Jira project key.`);
    return { target: flag, usedSaved: false };
  }
  const what = t === 'linear' ? '<team key>' : '<project key>';
  const question = t === 'linear' ? 'Which Linear team?' : 'Which Jira project?';
  const field: ChoiceField = t === 'linear' ? 'team' : 'project';
  try {
    if (!d.interactive) {
      return await ambiguous(o, need(flagName, what).message, async () => {
        const listed = t === 'linear' ? await listLinearTeams(fields, d.fetch) : await listJiraProjects(fields, d.fetch);
        return { field, question, options: listed.items.map((i) => ({ value: i.key, label: `${i.key}  ${i.name}` })) };
      });
    }
    const listed = t === 'linear' ? await listLinearTeams(fields, d.fetch) : await listJiraProjects(fields, d.fetch);
    if (listed.items.length === 0) throw need(flagName, 'with a key');
    const v = await d.choose(question, listed.items.map((i) => ({ value: i.key, label: `${i.key}  ${i.name}` })));
    if (!v) throw need(flagName, 'with a key');
    return { target: v, usedSaved: false };
  } catch (e) {
    if (e instanceof ScopeLookupError) throw new Stop(1, e.message);
    throw e;
  }
}

function footer(dec: DecisionInput, link: string | null): string {
  const lines = ['---', `From the decision: ${dec.title}`];
  if (link) lines.push(`Decision: ${link}`); else lines.push(`Decision id: ${dec.id}`);
  if (dec.sourceUrl) lines.push(`Source: ${dec.sourceUrl}`);
  lines.push('Created by `align backlog`.');
  return lines.join('\n');
}

function printPlan(d: BacklogDeps, tracker: TrackerId, target: string, dec: DecisionInput, tasks: PlannedTask[], verb: string): void {
  d.out(`${verb} ${tasks.length} ${tasks.length === 1 ? 'issue' : 'issues'} in ${TRACKER_LABEL[tracker]} (${target}) from "${dec.title}":`);
  for (const t of tasks) d.out(`  ${t.key ? `${t.key}  ` : '- '}${t.title}${t.url ? `  ${t.url}` : ''}`);
}

export async function runBacklog(o: BacklogOptions, d: BacklogDeps): Promise<number> {
  try {
    return await run(o, d);
  } catch (e) {
    if (e instanceof Stop) { d.err(e.message); return e.code; }
    if (e instanceof LockedError) { d.err(e.message); return 1; }
    d.err((e as Error).message);
    return 1;
  }
}

/** What a run is about, once every question is answered. `fields` carries the credential: it never leaves this process. */
export interface Resolved {
  dec: DecisionInput; tracker: TrackerId; target: string; key: string; fields: Record<string, string>;
  /** The destination came from this repo's saved target, not a flag. */
  usedSaved: boolean;
}

/** The credential for a tracker, or the Stop that says how to get one. The token flag, when given, replaces the saved token. */
export function credentialFor(tracker: TrackerId, token: string | undefined, d: BacklogDeps): Record<string, string> {
  const saved = d.credentials(tracker);
  const fields = token !== undefined ? { ...(saved ?? {}), token } : saved;
  if (fields === null || !fields['token']) throw new Stop(1, `No ${TRACKER_LABEL[tracker]} credential. Run: align connect ${tracker} (or pass --token).`);
  return fields;
}

/** The ledger's destination qualifier: the Jira site, or the Linear workspace. A read, never a write. */
async function workspaceOf(tracker: TrackerId, fields: Record<string, string>, d: BacklogDeps): Promise<string> {
  if (tracker === 'jira') return fields['domain'] ?? '';
  if (tracker !== 'linear') return '';
  try { return await linearWorkspace(fields, d.fetch); } catch (e) { throw new Stop(1, (e as Error).message); }
}

/** Answer every question (decision, tracker, credential, destination) without writing anything anywhere. */
export async function resolveBacklog(o: BacklogOptions, d: BacklogDeps): Promise<Resolved> {
  const dec = await pickDecision(o, d);
  const tracker = await pickTracker(o, d);
  // The credential comes before the model: no point spending an LLM call on tasks nothing can create.
  const fields = credentialFor(tracker, o.token, d);
  const { target, usedSaved } = await pickTarget(tracker, o, fields, d);
  const key = ledgerKey(dec.id, tracker, target, await workspaceOf(tracker, fields, d));
  return { dec, tracker, target, key, fields, usedSaved };
}

export interface Loaded { tasks: PlannedTask[]; /** Some of these were already created by an earlier run. */ resumed: boolean; /** All of them were. */ done: boolean }

/**
 * The ledger entry for this decision and destination. A Linear entry written before the workspace joined the key sits under
 * the old key; it is still this destination's work, so it is found there rather than created again.
 */
export function priorEntry(d: BacklogDeps, r: Resolved): LedgerEntry | undefined {
  return getEntry(d.ledgerPath, r.key) ?? (r.tracker === 'linear' ? getEntry(d.ledgerPath, ledgerKey(r.dec.id, r.tracker, r.target, '')) : undefined);
}

/** The tasks for this decision and destination: the ledger's, so a rerun resumes the SAME plan, else the model's. */
export async function loadTasks(o: BacklogOptions, d: BacklogDeps, r: Resolved): Promise<Loaded> {
  const max = o.max ?? DEFAULT_MAX_TASKS;
  if (!Number.isInteger(max) || max < 1 || max > 25) throw new Stop(2, '--max must be a whole number from 1 to 25.');
  const prior = o.force ? undefined : priorEntry(d, r);
  if (prior) return { tasks: prior.tasks, resumed: true, done: prior.tasks.every((t) => t.key) };
  const shaped = await d.shape(r.dec, max);
  if (!shaped.ok) throw new Stop(1, shaped.message);
  const parsed = parseTasks(shaped.text);
  if (parsed === null) throw new Stop(1, 'The model did not return a task list this CLI could read, so nothing was created. Run again.');
  if (parsed.length === 0) throw new Stop(1, 'The model found no work in this decision, so nothing was created.');
  if (parsed.length > max) d.out(`The model wrote ${parsed.length} tasks; keeping the first ${max} (--max).`);
  return { tasks: parsed.slice(0, max), resumed: false, done: false };
}

const FLAG_FOR: Record<TrackerId, string> = { linear: '--team', github: '--repo', jira: '--project' };

/** The line that says a saved target was used, and how to use another. */
export const savedTargetLine = (tracker: TrackerId, target: string): string =>
  `Using your saved target: ${TRACKER_LABEL[tracker]} ${target}. To use another, pass --tracker and ${FLAG_FOR[tracker]}; the next run that works becomes the new default.`;

async function run(o: BacklogOptions, d: BacklogDeps): Promise<number> {
  const r = await resolveBacklog(o, d);
  if (r.usedSaved) d.out(savedTargetLine(r.tracker, r.target));
  if (o.dryRun) {
    const l = await loadTasks(o, d, r);
    printPlan(d, r.tracker, r.target, r.dec, l.tasks, l.done ? 'Already created' : 'Would create');
    d.out(l.done ? 'Nothing to do. Use --force to create them again.' : 'Dry run: nothing was created.');
    return 0;
  }
  // From the "already created?" read to the last write: two runs may not both pass the check.
  return withLock(d.ledgerPath, async () => {
    const l = await loadTasks(o, d, r);
    if (l.done) {
      printPlan(d, r.tracker, r.target, r.dec, l.tasks, 'Already created');
      d.out('Nothing to do. Use --force to create them again.');
      return 0;
    }
    return (await createIssues(d, r, l.tasks, l.resumed)).code;
  });
}

/** Create every task that has no key yet, recording each as it happens. The caller holds the lock. */
export async function createIssues(d: BacklogDeps, r: Resolved, tasks: PlannedTask[], resumed: boolean): Promise<{ code: number; tasks: PlannedTask[] }> {
  const { tracker, target, dec, fields, key } = r;
  const pending = tasks.filter((t) => !t.key);
  for (const t of pending.filter((x) => x.uncertain)) d.out(`Check first: "${t.title}" may already exist from the earlier run (no answer came back).`);
  printPlan(d, tracker, target, dec, tasks, resumed ? 'Resuming' : 'Creating');
  if (resumed) d.out(`${pending.length} still to create.`);

  const link = d.decisionUrl(dec.id);
  let teamId: string | undefined;
  if (tracker === 'linear') {
    teamId = await resolveLinearTeamId(fields, target, d.fetch);
    if (teamId === undefined) throw new Stop(1, `This Linear credential cannot see a team with key "${target}".`);
  }
  const save = () => putEntry(d.ledgerPath, key, { tasks, at: new Date().toISOString() });
  save();
  let failed = 0;
  for (const t of pending) {
    const issue = { title: t.title, body: `${t.body}\n\n${footer(dec, link)}` };
    let made: CreatedIssue;
    try {
      made = tracker === 'linear' ? await createLinearIssue(fields, teamId!, issue, d.fetch)
        : tracker === 'github' ? await createGithubIssue(fields, target, issue, d.fetch)
        : await createJiraIssue(fields, target, issue, d.fetch);
    } catch (e) {
      d.err(`Failed: ${t.title}\n  ${(e as Error).message}`);
      failed++;
      // A credential that cannot write will not write the next one either.
      if (e instanceof CannotCreateError) break;
      // No answer came back, so the issue may exist: say so on the next run rather than quietly creating it twice.
      if (e instanceof MaybeCreatedError) { t.uncertain = true; save(); break; }
      continue;
    }
    t.key = made.key; t.url = made.url;
    save();
    d.out(`  created ${made.key}  ${made.url}`);
  }
  if (failed > 0) { d.err(`${failed} not created. Run the same command again to create only those.`); return { code: 1, tasks }; }
  rememberTarget(d, r);
  return { code: 0, tasks };
}

/** Save where this backlog went, once it has fully worked, so the next one asks nothing. Says so only when it changes. */
function rememberTarget(d: BacklogDeps, r: Resolved): void {
  if (!d.saveTarget) return;
  const was = d.savedTarget?.();
  if (was && was.tracker === r.tracker && was.target === r.target) return;
  d.saveTarget({ tracker: r.tracker, target: r.target });
  d.out(`Saved ${TRACKER_LABEL[r.tracker]} ${r.target} as the default for this repo. Next time: align backlog <decision>. To use another, pass ${FLAG_FOR[r.tracker]}.`);
}
