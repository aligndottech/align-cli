/**
 * LM: `align mark` and `align_mark` share this module, so the two surfaces cannot diverge
 * (LM.3): both parse into a `MarkAction` and both call `applyJudgement`. The only things that
 * differ between a person's mark and an agent's are `via` and `agent_id`.
 *
 * Nothing here talks to a network, and nothing is classified by a model: a mark is a person's
 * answer, stored as given.
 */
import { createHash } from 'node:crypto';
import { createLocalDb } from '../local-db.js';
import {
  existingTitles, type Judge, type Origin,
  removeJudgement, upsertJudgement, type Verdict,
} from './judgements-db.js';

/** The most files one check key covers. The key is computed over this capped list on BOTH sides (CLI and agent), so a huge diff still matches itself. */
export const MAX_CHECK_FILES = 500;
export const MAX_NOTE_CHARS = 2000;
export const SUPERSEDES_CONFIDENCE = 1;

export type MarkAction =
  | { action: 'conflict'; a: string; b: string; verdict: Verdict }
  | { action: 'check'; id: string; verdict: Verdict; files: string[] }
  | { action: 'replaces'; newer: string; older: string }
  | { action: 'not-a-decision'; id: string }
  | { action: 'note'; id: string; text: string };

/** `code` picks the exit status: a usage problem is 2, a decision that is not in the graph is 1. */
export class MarkError extends Error {
  constructor(readonly code: 'usage' | 'unknown-id', message: string) {
    super(message);
    this.name = 'MarkError';
  }
}

/** Repo-relative, forward-slashed, no leading `./`, sorted, de-duplicated, capped. Order and duplicates never change the key. */
export function normaliseFiles(files: readonly string[]): string[] {
  const clean = files
    .map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((f) => f !== '');
  return [...new Set(clean)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).slice(0, MAX_CHECK_FILES);
}

/** sha256 of the sorted paths joined by newline. An empty file list has NO key: a verdict on "no files" would cover every file-less check. */
export function contextKeyFor(files: readonly string[]): string | null {
  const list = normaliseFiles(files);
  if (list.length === 0) return null;
  return createHash('sha256').update(list.join('\n')).digest('hex');
}

/** The files a git-style diff touches, read from its `diff --git` headers (the b side, so a rename names where it went). */
export function filesFromDiff(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const at = line.lastIndexOf(' b/');
    if (at > 0) out.push(line.slice(at + 3));
  }
  return normaliseFiles(out);
}

const VERDICTS: readonly string[] = ['real', 'false'];
function isVerdict(v: string | undefined): v is Verdict {
  return v !== undefined && VERDICTS.includes(v);
}
export const USAGE = [
  'align mark conflict <a> <b> real|false',
  'align mark check <a> real|false [--files <f>...]',
  'align mark <a> replaces <b>',
  'align mark <a> not-a-decision [--undo]',
  'align mark <a> note "<text>"',
].join('\n  ');

/** Positional arguments to an action. `files` come from `--files`, or the caller's last check. */
export function parseMarkArgs(args: string[], files: string[] | undefined): MarkAction {
  const bad = (why: string): never => { throw new MarkError('usage', `${why}\n  Usage:\n  ${USAGE}`); };
  const [first, second, third, fourth, ...rest] = args;
  if (first === 'conflict') {
    if (!second || !third || !isVerdict(fourth) || rest.length) bad('A conflict mark needs two decision ids and real or false.');
    return { action: 'conflict', a: second!, b: third!, verdict: fourth as Verdict };
  }
  if (first === 'check') {
    if (!second || !isVerdict(third) || fourth !== undefined) bad('A check mark needs one decision id and real or false.');
    return { action: 'check', id: second!, verdict: third as Verdict, files: files ?? [] };
  }
  if (first && second === 'replaces') {
    if (!third || fourth !== undefined) bad('`replaces` needs the id of the decision being replaced.');
    return { action: 'replaces', newer: first, older: third! };
  }
  if (first && second === 'not-a-decision') {
    if (third !== undefined) bad('`not-a-decision` takes no further argument.');
    return { action: 'not-a-decision', id: first };
  }
  if (first && second === 'note') {
    if (!third || fourth !== undefined) bad('`note` needs the note text as one quoted argument.');
    return { action: 'note', id: first, text: third! };
  }
  return bad('Not a mark I recognise.');
}

export interface ApplyContext {
  dbPath: string;
  judge: Judge;
  origin: Origin;
  now?: Date;
}

export interface MarkOutcome {
  kind: 'conflict_verdict' | 'check_verdict' | 'supersede' | 'not_a_decision' | 'note';
  /** True when this person's earlier answer on the same key was replaced. */
  replaced: boolean;
  undone?: boolean;
  /** Plain words for the person or agent. Always says nothing was shared. */
  text: string;
}

const LOCAL_ONLY = 'Recorded on this machine only; nothing was shared or sent.';

function requireDecisions(dbPath: string, ids: string[]): Map<string, string> {
  const titles = existingTitles(dbPath, ids);
  for (const id of ids) {
    if (!titles.has(id)) throw new MarkError('unknown-id', `No decision ${id} in your local graph. \`align decisions list\` shows what is there.`);
  }
  return titles;
}

function same(a: string, b: string, what: string): void {
  if (a === b) throw new MarkError('usage', `${what} must name two different decisions.`);
}

export function applyJudgement(ctx: ApplyContext, m: MarkAction, opts: { undo?: boolean } = {}): MarkOutcome {
  const { dbPath, judge, origin, now } = ctx;
  const undo = opts.undo === true;
  switch (m.action) {
    case 'conflict': {
      same(m.a, m.b, 'A conflict mark');
      requireDecisions(dbPath, [m.a, m.b]);
      const [lo, hi] = m.a < m.b ? [m.a, m.b] : [m.b, m.a];
      const key = { kind: 'conflict_verdict' as const, decisionId: lo, counterpartId: hi };
      if (undo) {
        const n = removeJudgement(dbPath, key, judge);
        return { kind: key.kind, replaced: false, undone: n > 0, text: n ? 'Removed your verdict on that pair.' : 'You had no verdict on that pair.' };
      }
      const { replaced } = upsertJudgement(dbPath, { ...key, value: m.verdict }, judge, origin, now);
      return { kind: key.kind, replaced, text: `Marked the pair a ${m.verdict === 'false' ? 'false alarm' : 'real conflict'}${replaced ? ' (replacing your earlier answer)' : ''}. ${LOCAL_ONLY}` };
    }
    case 'check': {
      const titles = requireDecisions(dbPath, [m.id]);
      const contextKey = contextKeyFor(m.files);
      if (contextKey === null) {
        throw new MarkError('usage', 'A check verdict is about one set of files, and none was given. Pass the files the check covered (the check result lists them).');
      }
      const key = { kind: 'check_verdict' as const, decisionId: m.id, contextKey };
      if (undo) {
        const n = removeJudgement(dbPath, key, judge);
        return { kind: key.kind, replaced: false, undone: n > 0, text: n ? 'Removed your verdict for that set of files.' : 'You had no verdict for that set of files.' };
      }
      const { replaced } = upsertJudgement(dbPath, { ...key, value: m.verdict }, judge, origin, now);
      const files = normaliseFiles(m.files).length;
      return {
        kind: key.kind, replaced,
        text: m.verdict === 'false'
          ? `Marked "${titles.get(m.id)}" a false alarm for this set of ${files} file${files === 1 ? '' : 's'}. A later check touching exactly these files will hide it; any other files still show it. ${LOCAL_ONLY}`
          : `Marked "${titles.get(m.id)}" a real conflict for this set of ${files} file${files === 1 ? '' : 's'}${replaced ? ' (replacing your earlier answer)' : ''}. ${LOCAL_ONLY}`,
      };
    }
    case 'replaces': {
      same(m.newer, m.older, '`replaces`');
      const titles = requireDecisions(dbPath, [m.newer, m.older]);
      const key = { kind: 'supersede' as const, decisionId: m.newer, counterpartId: m.older };
      if (undo) {
        const n = removeJudgement(dbPath, key, judge);
        return {
          kind: key.kind, replaced: false, undone: n > 0,
          text: n ? 'Removed your replacement note. The supersedes link stays in the graph.' : 'You had no replacement note for that pair.',
        };
      }
      // The existing link writer; idempotent on (source, target, relation). Written first so a
      // failure between the two leaves nothing that claims a replacement the graph does not hold.
      const local = createLocalDb(dbPath);
      try {
        local.insertLink({ sourceId: m.newer, targetId: m.older, relation: 'supersedes', confidence: SUPERSEDES_CONFIDENCE });
      } finally {
        local.close();
      }
      const { replaced } = upsertJudgement(dbPath, key, judge, origin, now);
      return { kind: key.kind, replaced, text: `Recorded that "${titles.get(m.newer)}" replaces "${titles.get(m.older)}". A check that cites the older one now names the newer as current. ${LOCAL_ONLY}` };
    }
    case 'not-a-decision': {
      const titles = requireDecisions(dbPath, [m.id]);
      const key = { kind: 'not_a_decision' as const, decisionId: m.id };
      if (undo) {
        const n = removeJudgement(dbPath, key, judge);
        return { kind: key.kind, replaced: false, undone: n > 0, text: n ? `"${titles.get(m.id)}" is retrieved again.` : 'You had not marked that one.' };
      }
      const { replaced } = upsertJudgement(dbPath, key, judge, origin, now);
      return { kind: key.kind, replaced, text: `"${titles.get(m.id)}" is out of ask and check results. \`align decisions list --all\` still shows it. ${LOCAL_ONLY}` };
    }
    case 'note': {
      const titles = requireDecisions(dbPath, [m.id]);
      if (undo) throw new MarkError('usage', 'Notes append and cannot be undone by id. `align mark --list` shows them.');
      const text = m.text.trim();
      if (text === '') throw new MarkError('usage', 'A note needs some text.');
      if (text.length > MAX_NOTE_CHARS) throw new MarkError('usage', `A note is at most ${MAX_NOTE_CHARS} characters; this one is ${text.length}.`);
      upsertJudgement(dbPath, { kind: 'note', decisionId: m.id, note: text }, judge, origin, now);
      return { kind: 'note', replaced: false, text: `Added a note to "${titles.get(m.id)}". ${LOCAL_ONLY}` };
    }
  }
}
