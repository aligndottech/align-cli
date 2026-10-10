/**
 * LM: how the local guardrail reads this person's marks. Pure reads of `local_judgements`; the
 * client calls these and keeps its own flow.
 *
 * Fail direction: with no judge, no judgement rows, or a pre-v7 file, every function returns its
 * input unchanged - a mark can only HIDE or ANNOTATE what the guardrail found, so the absence of
 * marks leaves the guardrail exactly as strict as it was.
 *
 * A false verdict hides a hit ONLY for the file set it was given (Decision 28): suppressing a
 * decision everywhere because it misfired once would hide real conflicts.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { checkVerdictFor, pairVerdictFor } from './judgements-db.js';

export interface CheckConflict { decision_id: string; title: string; note?: string; [k: string]: unknown }

/** Whether the file holds any judgement at all: lets the common no-marks path skip identity lookup entirely. */
export function anyJudgements(dbPath: string): boolean {
  if (dbPath === '' || !fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    return (db.prepare('SELECT 1 AS x FROM local_judgements LIMIT 1').get() as unknown) !== undefined;
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return false;
    throw e;
  } finally {
    db.close();
  }
}

const day = (iso: string): string => iso.slice(0, 10);
/** Who made a mark, in words. A mark an agent relayed is always said so: a hit hidden by an agent is never invisible. */
const byWhom = (agentId: string | null): string => (agentId === null ? 'you' : `${agentId} via MCP`);

/** Drop hits this judge marked false for exactly this file set; annotate hits they marked false for another set. */
export function reviewConflicts<C extends CheckConflict>(
  dbPath: string, judgeId: string, conflicts: C[], contextKey: string | null,
): { conflicts: C[]; notes: string[] } {
  const kept: C[] = [];
  const notes: string[] = [];
  for (const c of conflicts) {
    const v = checkVerdictFor(dbPath, judgeId, c.decision_id, contextKey);
    if (v.here?.value === 'false') {
      notes.push(`"${c.title}" is hidden: marked false by ${byWhom(v.here.agent_id)} for this set of files on ${day(v.here.judged_at)}. Show it again with: align mark check ${c.decision_id} real`);
      continue;
    }
    if (v.elsewhereFalse && v.here === null) {
      const note = v.elsewhereFalse.agent_id === null
        ? `you marked this a false alarm once, on ${day(v.elsewhereFalse.judged_at)}, for a different set of files; it still shows here`
        : `marked false by ${byWhom(v.elsewhereFalse.agent_id)} once, on ${day(v.elsewhereFalse.judged_at)}, for a different set of files; it still shows here`;
      notes.push(`"${c.title}": ${note}.`);
      kept.push({ ...c, note });
      continue;
    }
    kept.push(c);
  }
  return { conflicts: kept, notes };
}

/** Stored conflict links, each annotated when this judge marked the pair (either id order). */
export function annotatePairs<L extends { sourceId: string; targetId: string }>(dbPath: string, judgeId: string, links: L[]): Array<L & { marked_by_you?: { verdict: string; judged_at: string; note: string } }> {
  return links.map((l) => {
    const v = pairVerdictFor(dbPath, judgeId, l.sourceId, l.targetId);
    if (!v) return l;
    const who = v.agent_id === null ? 'you' : `${v.agent_id} via MCP`;
    const note = v.value === 'false' ? `marked false alarm by ${who} on ${day(v.judged_at)}` : `marked a real conflict by ${who} on ${day(v.judged_at)}`;
    return { ...l, marked_by_you: { verdict: v.value, judged_at: v.judged_at, note } };
  });
}
