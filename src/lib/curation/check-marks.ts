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
import { MAX_CHECK_FILES } from './mark.js';
import type { MarkMeta } from './judgements-db.js';

export interface Retrieved { decisionId: string }

/**
 * Walk the ranked rows, keeping up to `limit` that are not hidden. A hidden row counts as dropped
 * only if it ranked inside the cut: a hidden decision that would not have been returned anyway
 * is not "left out of" anything.
 */
export function splitRetrieved<T extends Retrieved>(
  raw: readonly T[], hidden: ReadonlyMap<string, MarkMeta>, limit: number, titleOf: (id: string) => string | undefined,
): { kept: T[]; dropped: number; notes: string[] } {
  const kept: T[] = [];
  const notes: string[] = [];
  for (const row of raw) {
    if (kept.length >= limit) break;
    const meta = hidden.get(row.decisionId);
    if (meta) notes.push(droppedNote(titleOf(row.decisionId) ?? row.decisionId, meta));
    else kept.push(row);
  }
  return { kept, dropped: notes.length, notes };
}

/** The answer when nothing is left to check. With drops it carries the reason; without, it is the plain empty answer. */
export function emptyCheck(dropped: number, notes: string[]): {
  status: 'no-context'; confidence: number; relevant_decisions: []; conflicts: []; message: string; notes?: string[];
} {
  if (dropped === 0) return { status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [], message: 'No related decisions found in your local graph.' };
  const summary = hiddenSummary(dropped);
  return { status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [], message: `${summary}.`, notes: [...notes, summary] };
}

/** Every note a check carries beyond the conflicts themselves: decisions left out, decisions declared replaced, a diff too large for a file-set mark. */
export function checkNotes(
  dbPath: string, judgeId: string | undefined, leftOut: readonly string[],
  decisions: ReadonlyArray<{ id: string; title: string; successor?: { title: string } }>,
  reviewed: readonly string[], fileCount: number,
): string[] {
  const notes = [...leftOut];
  if (judgeId) {
    for (const d of decisions) {
      const n = d.successor ? supersedeNote(dbPath, judgeId, d.id, d.title, d.successor.title) : null;
      if (n) notes.push(n);
    }
  }
  notes.push(...reviewed);
  if (fileCount > MAX_CHECK_FILES) notes.push(`This check covers ${fileCount} files, more than ${MAX_CHECK_FILES}, so no file-set mark can hide or annotate anything in it.`);
  return notes;
}
