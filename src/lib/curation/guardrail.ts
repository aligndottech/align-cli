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
import { agentRetrievalMarks, checkVerdictFor, type MarkMeta, pairVerdictsFor, supersedeMarkFor } from './judgements-db.js';
import { agentLabel, quote } from './text.js';

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
export const byWhom = (agentId: string | null): string => (agentId === null ? 'you' : `${agentLabel(agentId)} via MCP`);

/** Drop hits this judge marked false for exactly this file set; annotate hits they marked false for another set. */
export function reviewConflicts<C extends CheckConflict>(
  dbPath: string, judgeId: string, conflicts: C[], contextKey: string | null, files: readonly string[] = [],
): { conflicts: C[]; notes: string[] } {
  const kept: C[] = [];
  const notes: string[] = [];
  for (const c of conflicts) {
    const v = checkVerdictFor(dbPath, judgeId, c.decision_id, contextKey);
    if (v.here?.value === 'false') {
      notes.push(`${quote(c.title)} is hidden: marked false by ${byWhom(v.here.agent_id)} for this set of files on ${day(v.here.judged_at)}. Show it again with: align mark check ${c.decision_id} real --files ${shellFiles(files)}`);
      continue;
    }
    if (v.elsewhereFalse && v.here === null) {
      const note = v.elsewhereFalse.agent_id === null
        ? `you marked this a false alarm once, on ${day(v.elsewhereFalse.judged_at)}, for a different set of files; it still shows here`
        : `marked false by ${byWhom(v.elsewhereFalse.agent_id)} once, on ${day(v.elsewhereFalse.judged_at)}, for a different set of files; it still shows here`;
      notes.push(`${quote(c.title)}: ${note}.`);
      kept.push({ ...c, note });
      continue;
    }
    kept.push(c);
  }
  return { conflicts: kept, notes };
}

/** Stored conflict links, each annotated when this judge marked the pair (either id order). One read for the whole list. */
export function annotatePairs<L extends { sourceId: string; targetId: string }>(dbPath: string, judgeId: string, links: L[]): Array<L & { marked_by_you?: { verdict: string; judged_at: string; note: string } }> {
  const verdicts = pairVerdictsFor(dbPath, judgeId);
  return links.map((l) => {
    const v = verdicts.get(l.sourceId < l.targetId ? `${l.sourceId}|${l.targetId}` : `${l.targetId}|${l.sourceId}`);
    if (!v) return l;
    const who = v.agent_id === null ? 'you' : `${v.agent_id} via MCP`;
    const note = v.value === 'false' ? `marked false alarm by ${who} on ${day(v.judged_at)}` : `marked a real conflict by ${who} on ${day(v.judged_at)}`;
    return { ...l, marked_by_you: { verdict: v.value, judged_at: v.judged_at, note } };
  });
}

/** File paths as arguments a shell reads back as the same list: each one single-quoted. */
export function shellFiles(files: readonly string[]): string {
  return files.map((f) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(f) ? f : `'${f.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** One line per retrieved decision a mark kept out of this check, naming who marked it and when. */
export function droppedNote(title: string, meta: MarkMeta): string {
  return `${quote(title)} was left out of this check: marked not a decision by ${byWhom(meta.agent_id)} on ${day(meta.judged_at)}.`;
}

export function hiddenSummary(n: number): string {
  return `${n} related decision${n === 1 ? ' is' : 's are'} hidden by your marks (run \`align mark --list\`)`;
}

/** A supersede mark: the older decision is named as replaced, by whom and when. Only for a replacement this judge recorded. */
export function supersedeNote(dbPath: string, judgeId: string, olderId: string, olderTitle: string, newerTitle: string): string | null {
  const m = supersedeMarkFor(dbPath, judgeId, olderId);
  return m ? `${quote(olderTitle)} is superseded by ${quote(newerTitle)}: marked by ${byWhom(m.agent_id)} on ${day(m.judged_at)}.` : null;
}

/** The one-line banner every check carries while an AGENT's mark changes what it returns. */
export function agentBanner(dbPath: string, judgeId: string): string | null {
  const m = agentRetrievalMarks(dbPath, judgeId);
  if (!m) return null;
  return `${m.count} mark${m.count === 1 ? '' : 's'} by agents since ${day(m.since)} affect${m.count === 1 ? 's' : ''} this check (align mark --list)`;
}
