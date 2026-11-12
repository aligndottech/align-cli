import { listJiraProjects, listLinearTeams, ScopeLookupError } from '../scope-choices.js';
import { getEntry, ledgerKey, type PlannedTask, putEntry } from './ledger.js';
import { parseTasks, type ShapeResult } from './shape.js';
import {
  CannotCreateError, type CreatedIssue, createGithubIssue, createJiraIssue, createLinearIssue, isJiraProject, isRepo, MaybeCreatedError,
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
  out(line: string): void;
  err(line: string): void;
}

export const DEFAULT_MAX_TASKS = 8;
const ID_SHAPE = /^[0-9a-f][0-9a-f-]{6,}$/i;
const ID_HINT = 'Pass the decision id (align decisions list) to choose one.';

class Stop extends Error { constructor(readonly code: number, message: string) { super(message); } }

async function pickDecision(o: BacklogOptions, d: BacklogDeps): Promise<DecisionInput> {
  if (ID_SHAPE.test(o.decision)) {
    try { return await d.getDecision(o.decision); } catch (e) {
      // A word that happens to look like an id is still searchable; only a miss on a real lookup falls through.
      if (!/not found|404/i.test((e as Error).message)) throw new Stop(1, `Could not read that decision: ${(e as Error).message}`);
    }
  }
  if (!d.interactive) throw new Stop(2, `"${o.decision}" is not a decision id and there is no terminal to confirm a search match. ${ID_HINT}`);
  const hits = await d.search(o.decision);
  if (hits.length === 0) throw new Stop(1, `No decision matches "${o.decision}".`);
  if (hits.length === 1) return hits[0]!;
  const id = await d.choose('Which decision?', hits.slice(0, 8).map((h) => ({ value: h.id, label: h.title })));
  const hit = hits.find((h) => h.id === id);
  if (!hit) throw new Stop(1, 'No decision chosen.');
  return hit;
}

function pickTracker(o: BacklogOptions, d: BacklogDeps): Promise<TrackerId> | TrackerId {
  if (o.tracker !== undefined) {
    const t = TRACKERS.find((x) => x === o.tracker);
    if (!t) throw new Stop(2, `Unknown tracker "${o.tracker}". Use one of: ${TRACKERS.join(', ')}.`);
    return t;
  }
  const have = TRACKERS.filter((t) => d.credentials(t) !== null);
  if (have.length === 1) return have[0]!;
  if (have.length === 0) throw new Stop(1, `No tracker connected. Run: align connect linear (or github, jira), or pass --tracker with --token.`);
  if (!d.interactive) throw new Stop(2, `More than one tracker is connected (${have.join(', ')}). Pass --tracker <${have.join('|')}>.`);
  return d.choose('Which tracker?', have.map((t) => ({ value: t, label: TRACKER_LABEL[t] }))).then((v) => {
    if (!v || !have.some((t) => t === v)) throw new Stop(1, 'No tracker chosen.');
    return v as TrackerId;
  });
}

/** The destination, as a short name for the plan and the ledger. Never guessed: a flag, a one-item list, or one question. */
async function pickTarget(t: TrackerId, o: BacklogOptions, fields: Record<string, string>, d: BacklogDeps): Promise<string> {
  const need = (flag: string, what: string) => new Stop(2, `Say where the issues go: pass ${flag} ${what}.`);
  if (t === 'github') {
    if (o.repo === undefined) {
      if (!d.interactive) throw need('--repo', '<owner/repo>');
      const v = await d.choose('Which repository (owner/repo)?', []);
      if (!v) throw need('--repo', '<owner/repo>');
      o = { ...o, repo: v };
    }
    if (!isRepo(o.repo!)) throw new Stop(2, `"${o.repo}" is not an owner/repo name.`);
    return o.repo!;
  }
  const flag = t === 'linear' ? o.team : o.project;
  const flagName = t === 'linear' ? '--team' : '--project';
  if (flag !== undefined) {
    if (t === 'jira' && !isJiraProject(flag)) throw new Stop(2, `"${flag}" is not a Jira project key.`);
    return flag;
  }
  if (!d.interactive) throw need(flagName, t === 'linear' ? '<team key>' : '<project key>');
  try {
    const listed = t === 'linear' ? await listLinearTeams(fields, d.fetch) : await listJiraProjects(fields, d.fetch);
    if (listed.items.length === 0) throw need(flagName, 'with a key');
    const v = await d.choose(t === 'linear' ? 'Which Linear team?' : 'Which Jira project?', listed.items.map((i) => ({ value: i.key, label: `${i.key}  ${i.name}` })));
    if (!v) throw need(flagName, 'with a key');
    return v;
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
    d.err((e as Error).message);
    return 1;
  }
}

async function run(o: BacklogOptions, d: BacklogDeps): Promise<number> {
  const max = o.max ?? DEFAULT_MAX_TASKS;
  if (!Number.isInteger(max) || max < 1 || max > 25) throw new Stop(2, '--max must be a whole number from 1 to 25.');
  const dec = await pickDecision(o, d);
  const tracker = await pickTracker(o, d);
  // The credential comes before the model: no point spending an LLM call on tasks nothing can create.
  const saved = d.credentials(tracker);
  const fields = o.token !== undefined ? { ...(saved ?? {}), token: o.token } : saved;
  if (fields === null || !fields['token']) throw new Stop(1, `No ${TRACKER_LABEL[tracker]} credential. Run: align connect ${tracker} (or pass --token).`);
  const target = await pickTarget(tracker, o, fields, d);
  const key = ledgerKey(dec.id, tracker, target, tracker === 'jira' ? fields['domain'] ?? '' : '');

  let tasks: PlannedTask[];
  const prior = o.force ? undefined : getEntry(d.ledgerPath, key);
  if (prior) {
    tasks = prior.tasks;
    if (tasks.every((t) => t.key)) {
      printPlan(d, tracker, target, dec, tasks, 'Already created');
      d.out('Nothing to do. Use --force to create them again.');
      return 0;
    }
  } else {
    const shaped = await d.shape(dec, max);
    if (!shaped.ok) throw new Stop(1, shaped.message);
    const parsed = parseTasks(shaped.text);
    if (parsed === null) throw new Stop(1, 'The model did not return a task list this CLI could read, so nothing was created. Run again.');
    if (parsed.length === 0) throw new Stop(1, 'The model found no work in this decision, so nothing was created.');
    tasks = parsed.slice(0, max);
    if (parsed.length > max) d.out(`The model wrote ${parsed.length} tasks; keeping the first ${max} (--max).`);
  }

  const pending = tasks.filter((t) => !t.key);
  for (const t of pending.filter((x) => x.uncertain)) d.out(`Check first: "${t.title}" may already exist from the earlier run (no answer came back).`);
  if (o.dryRun) {
    printPlan(d, tracker, target, dec, tasks, 'Would create');
    d.out('Dry run: nothing was created.');
    return 0;
  }
  printPlan(d, tracker, target, dec, tasks, prior ? 'Resuming' : 'Creating');
  if (prior) d.out(`${pending.length} still to create.`);

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
  if (failed > 0) { d.err(`${failed} not created. Run the same command again to create only those.`); return 1; }
  return 0;
}
