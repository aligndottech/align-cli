/**
 * LM: what a person's marks take out of a retrieval, said out loud.
 *
 * A mark may keep a related decision out of `ask` and `check`. That is legitimate (a person said
 * it is not a decision), but a check that was red and turns green because something was dropped
 * must never look like a check that found nothing. So every decision dropped by a mark is named
 * with who marked it and when, and a retrieval whose ONLY candidates were dropped answers
 * "no-context" WITH the note that says so.
 */
import { droppedNote, hiddenSummary, supersedeNote } from './guardrail.js';
import type { MarkMeta } from './judgements-db.js';
import { contextKeyFor, MAX_CHECK_FILES } from './mark.js';
import { hasUnsafeChars } from './text.js';

export interface Retrieved { decisionId: string }

/** What a retrieval left out because of marks, and when each AGENT-made mark that did it was made. */
export interface Dropped { dropped: number; notes: string[]; agentApplied: string[] }

/**
 * Walk the ranked rows, keeping up to `limit` that are not hidden. A hidden row counts as dropped
 * only if it ranked inside the cut: a hidden decision that would not have been returned anyway
 * is not "left out of" anything. `scope` is the word the note uses for what was left out of
 * ("check" or "answer").
 */
export function splitRetrieved<T extends Retrieved>(
  raw: readonly T[], hidden: ReadonlyMap<string, MarkMeta>, limit: number, titleOf: (id: string) => string | undefined, scope: 'check' | 'answer' = 'check',
): Dropped & { kept: T[] } {
  const kept: T[] = [];
  const out: Dropped = { dropped: 0, notes: [], agentApplied: [] };
  for (const row of raw) {
    if (kept.length >= limit) break;
    const meta = hidden.get(row.decisionId);
    if (!meta) { kept.push(row); continue; }
    out.dropped += 1;
    out.notes.push(droppedNote(titleOf(row.decisionId) ?? row.decisionId, meta, scope));
    if (meta.agent_id !== null) out.agentApplied.push(meta.judged_at);
  }
  return { kept, ...out };
}

/**
 * The line every check carries while an AGENT's mark changed what it returned: it hid a hit for this
 * file set, left a decision out, or declared one replaced. A mark that did not apply to this check
 * says nothing, so the banner does not become noise that is read past.
 */
export function bannerFor(agentApplied: readonly string[]): string[] {
  if (agentApplied.length === 0) return [];
  const n = agentApplied.length;
  const since = [...agentApplied].sort()[0].slice(0, 10);
  return [`${n} mark${n === 1 ? '' : 's'} by agents since ${since} affect${n === 1 ? 's' : ''} this check (align mark --list)`];
}

/** The answer when nothing is left to check. With drops it carries the reason; without, it is the plain empty answer. */
export function emptyCheck(d: Dropped): {
  status: 'no-context'; confidence: number; relevant_decisions: []; conflicts: []; message: string; notes?: string[];
} {
  if (d.dropped === 0) return { status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [], message: 'No related decisions found in your local graph.' };
  const summary = hiddenSummary(d.dropped);
  return { status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [], message: `${summary}.`, notes: [...bannerFor(d.agentApplied), ...d.notes, summary] };
}

/** Every note a check carries beyond the conflicts themselves, the banner first. */
export function checkNotes(
  dbPath: string, judgeId: string | undefined, left: Dropped,
  decisions: ReadonlyArray<{ id: string; title: string; successor?: { title: string } }>,
  reviewed: { notes: string[]; agentApplied: string[] }, files: readonly string[],
): string[] {
  const applied = [...left.agentApplied, ...reviewed.agentApplied];
  const notes = [...left.notes];
  if (judgeId) {
    for (const d of decisions) {
      const s = d.successor ? supersedeNote(dbPath, judgeId, d.id, d.title, d.successor.title) : null;
      if (!s) continue;
      notes.push(s.note);
      if (s.agentJudgedAt) applied.push(s.agentJudgedAt);
    }
  }
  notes.push(...reviewed.notes);
  if (files.some(hasUnsafeChars)) notes.push('This check touches a path with control characters or invisible ones, so no file-set mark can hide or annotate anything in it.');
  else if (files.length > MAX_CHECK_FILES) notes.push(`This check covers ${files.length} files, more than ${MAX_CHECK_FILES}, so no file-set mark can hide or annotate anything in it.`);
  return [...bannerFor(applied), ...notes];
}

/** The file list a check offers for marking, or undefined when the set has no key (none, too many, or an unnameable path). */
export function offeredFiles(files: readonly string[]): readonly string[] | undefined {
  return contextKeyFor(files) === null ? undefined : files;
}
