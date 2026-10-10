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
import { hasUnsafeChars, quote } from './text.js';
import {
  agentWouldOverrideHuman, existingTitles, HumanMarkError, type Judge, type JudgementWrite, type Origin,
  removeJudgement, upsertJudgement, type Verdict,
} from './judgements-db.js';

/**
 * The most files one check key covers. A check over more files has NO key (it cannot be hidden by
 * a file-set mark, and a mark cannot be made for it): cutting the list would let a verdict given
 * for the first 500 files hide the hit on any superset of them.
 *
 * The key is a sha256 of the file list and is REVERSIBLE for a small set (hash the likely paths of
 * the repo and compare). It stays on this machine: nothing that is shared may carry `context_key`
 * or a path (the share phase reads kind, value, note, via, agent and time only).
 */
export const MAX_CHECK_FILES = 500;
export const MAX_NOTE_CHARS = 500;
export const SUPERSEDES_CONFIDENCE = 1;

export type MarkAction =
  | { action: 'conflict'; a: string; b: string; verdict: Verdict }
  | { action: 'check'; id: string; verdict: Verdict; files: string[] }
  | { action: 'replaces'; newer: string; older: string }
  | { action: 'not-a-decision'; id: string }
  | { action: 'note'; id: string; text: string };

/** `code` picks the exit status: a usage problem is 2, a decision that is not in the graph is 1. `refused`: nothing was stored, by rule. */
export class MarkError extends Error {
  constructor(readonly code: 'usage' | 'unknown-id' | 'refused', message: string) {
    super(message);
    this.name = 'MarkError';
  }
}

/** Repo-relative, forward-slashed, no leading `./`, sorted, de-duplicated. Order and duplicates never change the key. Never cut. */
export function normaliseFiles(files: readonly string[]): string[] {
  const clean = files
    .map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((f) => f !== '');
  return [...new Set(clean)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

/** sha256 of the sorted paths joined by newline. No files, or more than 500, has NO key. */
export function contextKeyFor(files: readonly string[]): string | null {
  const list = normaliseFiles(files);
  if (list.length === 0 || list.length > MAX_CHECK_FILES) return null;
  return createHash('sha256').update(list.join('\n')).digest('hex');
}

/** A C-style quoted path as git writes one: `\"` `\\` `\t` `\n` and `\NNN` octal UTF-8 bytes. */
function unquoteGitPath(raw: string): string | null {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return null;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const e = esc[body[i + 1]];
    if (e === undefined) return null;
    bytes.push(e);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `a/<path>` or `b/<path>` (quoted or not) to the path; null for /dev/null or an unreadable name. */
function sidePath(token: string, side: 'a' | 'b'): string | null {
  const t = token.replace(/\t.*$/, '');
  const unq = unquoteGitPath(t) ?? t;
  if (unq === '/dev/null') return null;
  return unq.startsWith(`${side}/`) ? unq.slice(2) : null;
}

/** The path of a `diff --git a/P b/P` header when both sides are the same path (so it is unambiguous even with spaces). */
function symmetricHeaderPath(rest: string): string | null {
  const q = /^("a\/(?:[^"\\]|\\.)*") ("b\/(?:[^"\\]|\\.)*")$/.exec(rest);
  if (q) return sidePath(q[2], 'b');
  const n = rest.length - 5;
  if (n <= 0 || n % 2 !== 0) return null;
  const p = n / 2;
  return rest.startsWith('a/') && rest.slice(2, 2 + p) === rest.slice(p + 5) && rest.slice(2 + p, 5 + p) === ' b/' ? rest.slice(2, 2 + p) : null;
}

/**
 * The files a git-style diff touches. Per `diff --git` block: the `+++` path, else the `---` path (a
 * deletion), else `rename to`, else a symmetric header. The `+++`/`---` lines count only before the
 * first hunk, because inside a hunk an added line `++ b/x` reads as `+++ b/x`.
 */
export function filesFromDiff(diff: string): string[] {
  const out: string[] = [];
  let open = false;
  let inHunk = false;
  let header = '';
  let plus: string | null = null;
  let minus: string | null = null;
  let renamed: string | null = null;
  const flush = (): void => {
    if (!open) return;
    const f = plus ?? renamed ?? minus ?? symmetricHeaderPath(header);
    if (f) out.push(f);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      open = true; inHunk = false; header = line.slice('diff --git '.length); plus = null; minus = null; renamed = null;
      continue;
    }
    if (!open) continue;
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk) continue;
    if (line.startsWith('+++ ')) plus = sidePath(line.slice(4), 'b');
    else if (line.startsWith('--- ')) minus = sidePath(line.slice(4), 'a');
    else if (line.startsWith('rename to ')) renamed = unquoteGitPath(line.slice(10)) ?? line.slice(10);
  }
  flush();
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
    if (!titles.has(id)) throw new MarkError('unknown-id', `No decision ${quote(id)} in your local graph. \`align decisions list\` shows what is there.`);
  }
  return titles;
}

function same(a: string, b: string, what: string): void {
  if (a === b) throw new MarkError('usage', `${what} must name two different decisions.`);
}

/** The command a person runs to change a mark themselves. */
function commandFor(m: MarkAction): string {
  switch (m.action) {
    case 'conflict': return `align mark conflict ${m.a} ${m.b} real|false`;
    case 'check': return `align mark check ${m.id} real|false --files <file>...`;
    case 'replaces': return `align mark ${m.newer} replaces ${m.older} [--undo]`;
    case 'not-a-decision': return `align mark ${m.id} not-a-decision --undo`;
    case 'note': return `align mark ${m.id} note "<text>"`;
  }
}

/** The command only a PERSON may run for the acts an agent is refused. */
export function personCommandFor(m: MarkAction): string {
  return m.action === 'replaces' ? `align mark ${m.newer} replaces ${m.older}` : m.action === 'not-a-decision' ? `align mark ${m.id} not-a-decision` : commandFor(m);
}

function writeOf(m: MarkAction): JudgementWrite | null {
  switch (m.action) {
    case 'conflict': { const [lo, hi] = m.a < m.b ? [m.a, m.b] : [m.b, m.a]; return { kind: 'conflict_verdict', decisionId: lo, counterpartId: hi }; }
    case 'check': { const k = contextKeyFor(m.files); return k === null ? null : { kind: 'check_verdict', decisionId: m.id, contextKey: k }; }
    case 'replaces': return { kind: 'supersede', decisionId: m.newer, counterpartId: m.older };
    case 'not-a-decision': return { kind: 'not_a_decision', decisionId: m.id };
    case 'note': return null;
  }
}

/** Notes are stored and printed in a terminal and in an agent's context: no control characters, no line breaks, short. */
export function checkNote(text: string): string {
  const t = text.trim();
  if (t === '') throw new MarkError('usage', 'A note needs some text.');
  if (hasUnsafeChars(t)) throw new MarkError('usage', 'A note cannot hold control characters or line breaks (a newline, tab, escape, or a text-direction override). Write it on one line of ordinary text.');
  if ([...t].length > MAX_NOTE_CHARS) throw new MarkError('usage', `A note is at most ${MAX_NOTE_CHARS} characters; this one is ${[...t].length}.`);
  return t;
}

export function applyJudgement(ctx: ApplyContext, m: MarkAction, opts: { undo?: boolean; force?: boolean } = {}): MarkOutcome {
  const refuse = (): never => { throw new MarkError('refused', `You marked this yourself; run \`${commandFor(m)}\` to change it. Nothing was stored.`); };
  // An agent may record a verdict or a note. Hiding a decision, or declaring it replaced, is the
  // person's: the label on an agent's mark is a name it reports about itself, not proof of who is typing.
  if (ctx.origin.via === 'mcp' && (m.action === 'replaces' || m.action === 'not-a-decision')) {
    throw new MarkError('refused', `Only the person can do that, not an agent. Ask the user to run: ${personCommandFor(m)}`);
  }
  // Before any side effect (the supersedes link below is written ahead of the row).
  if (ctx.origin.via === 'mcp' && !opts.undo) {
    const w = writeOf(m);
    if (w && agentWouldOverrideHuman(ctx.dbPath, w, ctx.judge)) refuse();
  }
  try {
    return applyChecked(ctx, m, opts);
  } catch (e) {
    if (e instanceof HumanMarkError) return refuse();
    throw e;
  }
}

function applyChecked(ctx: ApplyContext, m: MarkAction, opts: { undo?: boolean; force?: boolean }): MarkOutcome {
  const { dbPath, judge, origin, now } = ctx;
  const undo = opts.undo === true;
  switch (m.action) {
    case 'conflict': {
      same(m.a, m.b, 'A conflict mark');
      requireDecisions(dbPath, [m.a, m.b]);
      const [lo, hi] = m.a < m.b ? [m.a, m.b] : [m.b, m.a];
      const key = { kind: 'conflict_verdict' as const, decisionId: lo, counterpartId: hi };
      if (undo) {
        const n = removeJudgement(dbPath, key, judge).length;
        return { kind: key.kind, replaced: false, undone: n > 0, text: n ? 'Removed your verdict on that pair.' : 'You had no verdict on that pair.' };
      }
      const { replaced } = upsertJudgement(dbPath, { ...key, value: m.verdict }, judge, origin, now);
      return { kind: key.kind, replaced, text: `Marked the pair a ${m.verdict === 'false' ? 'false alarm' : 'real conflict'}${replaced ? ' (replacing your earlier answer)' : ''}. ${LOCAL_ONLY}` };
    }
    case 'check': {
      const titles = requireDecisions(dbPath, [m.id]);
      const files = normaliseFiles(m.files);
      const contextKey = contextKeyFor(files);
      if (contextKey === null) {
        throw new MarkError('usage', files.length > MAX_CHECK_FILES
          ? `That check covered ${files.length} files. A verdict is kept for at most ${MAX_CHECK_FILES}, so it cannot be recorded (and nothing is ever hidden for a check that large).`
          : 'A check verdict is about one set of files, and none was given. Pass the files the check covered (the check result lists them).');
      }
      const key = { kind: 'check_verdict' as const, decisionId: m.id, contextKey };
      if (undo) {
        const n = removeJudgement(dbPath, key, judge).length;
        return { kind: key.kind, replaced: false, undone: n > 0, text: n ? 'Removed your verdict for that set of files.' : 'You had no verdict for that set of files.' };
      }
      const { replaced } = upsertJudgement(dbPath, { ...key, value: m.verdict }, judge, origin, now);
      const covered = `${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 10).map(quote).join(', ')}${files.length > 10 ? `, and ${files.length - 10} more` : ''}`;
      return {
        kind: key.kind, replaced,
        text: m.verdict === 'false'
          ? `Marked ${quote(titles.get(m.id) ?? '')} a false alarm for exactly this set of ${covered}. A later check touching exactly these files will hide it; any other files still show it. ${LOCAL_ONLY}`
          : `Marked ${quote(titles.get(m.id) ?? '')} a real conflict for exactly this set of ${covered}${replaced ? ' (replacing your earlier answer)' : ''}. ${LOCAL_ONLY}`,
      };
    }
    case 'replaces': {
      same(m.newer, m.older, '`replaces`');
      const titles = requireDecisions(dbPath, [m.newer, m.older]);
      const key = { kind: 'supersede' as const, decisionId: m.newer, counterpartId: m.older };
      if (undo) {
        const removed = removeJudgement(dbPath, key, judge);
        if (removed.length === 0) return { kind: key.kind, replaced: false, undone: false, text: 'You had no replacement mark for that pair.' };
        const local = createLocalDb(dbPath);
        let links = 0;
        try { for (const id of removed) links += local.deleteMarkLink(id); } finally { local.close(); }
        return {
          kind: key.kind, replaced: false, undone: true,
          text: links ? 'Removed your replacement mark and the supersedes link it created.' : 'Removed your replacement mark. A supersedes link between them that you did not create (a classifier made it) stays.',
        };
      }
      const local = createLocalDb(dbPath);
      try {
        const older = local.getDecisionById(m.older);
        if (!opts.force && older && (older.ratifiedAt || older.confirmedAt)) {
          throw new MarkError('refused', `${quote(titles.get(m.older) ?? '')} is ${older.ratifiedAt ? 'ratified' : 'confirmed'}. Replacing a decision a person stood behind needs --force, at a terminal: align mark ${m.newer} replaces ${m.older} --force`);
        }
        // The judgement is written FIRST so the link can carry its id: `--undo` then deletes exactly this link.
        const { replaced, id } = upsertJudgement(dbPath, key, judge, origin, now);
        local.insertLink({ id: `mark:${id}`, sourceId: m.newer, targetId: m.older, relation: 'supersedes', confidence: SUPERSEDES_CONFIDENCE });
        return { kind: key.kind, replaced, text: `Recorded that ${quote(titles.get(m.newer) ?? '')} replaces ${quote(titles.get(m.older) ?? '')}. A check that cites the older one now names the newer as current; \`--undo\` takes it back. ${LOCAL_ONLY}` };
      } finally {
        local.close();
      }
    }
    case 'not-a-decision': {
      const titles = requireDecisions(dbPath, [m.id]);
      const key = { kind: 'not_a_decision' as const, decisionId: m.id };
      if (undo) {
        const n = removeJudgement(dbPath, key, judge).length;
        return { kind: key.kind, replaced: false, undone: n > 0, text: n ? `${quote(titles.get(m.id) ?? '')} is retrieved again.` : 'You had not marked that one.' };
      }
      const { replaced } = upsertJudgement(dbPath, key, judge, origin, now);
      return { kind: key.kind, replaced, text: `${quote(titles.get(m.id) ?? '')} is out of ask and check results (every check says how many marks hide something). \`align decisions list --all\` still shows it. ${LOCAL_ONLY}` };
    }
    case 'note': {
      const titles = requireDecisions(dbPath, [m.id]);
      if (undo) throw new MarkError('usage', 'Notes append and cannot be undone by id. `align mark --list` shows them.');
      const text = checkNote(m.text);
      upsertJudgement(dbPath, { kind: 'note', decisionId: m.id, note: text }, judge, origin, now);
      return { kind: 'note', replaced: false, text: `Added a note to ${quote(titles.get(m.id) ?? '')}. ${LOCAL_ONLY}` };
    }
  }
}
