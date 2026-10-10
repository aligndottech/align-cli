/**
 * `align local relink --detector v1`: re-type existing v0 links with the v1 detector, explicitly.
 *
 * Schema v12 stamped every existing link 'v0' and nothing re-types a link silently, so this is
 * the one path that does. Its rules:
 * - It reads v0 links only, never a person's mark link (`mark:<judgement>`), and skips a pair
 *   that already carries a v1 row, so a second run does not pay for the same pairs.
 * - One model call per SOURCE decision, over every target it links to: the source is the NEW
 *   DECISION, the targets the SIMILAR DECISIONS (the orientation the capture pass writes).
 * - A target v1 gives no relationship reads `relates`, the edge the capture pass would write.
 * - Dry run (apply false) writes nothing. apply without replace ADDS a v1 row for each pair whose
 *   type changed and keeps every v0 row. apply with replace swaps each re-classified pair's edge
 *   for the v1 row (a person's mark link survives, as replaceLink guarantees).
 * - A failed call writes nothing for that source; a stopped provider ends the run.
 */
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from './local-db.js';
import { classifyCandidateSet, type SetCandidate } from './local-set-classifier.js';

export interface RelinkOptions { apply: boolean; replace: boolean; limit?: number }

export interface RelinkReport {
  sources: number;
  remainingSources: number;
  calls: number;
  changes: Array<{ sourceId: string; targetId: string; from: string; to: string }>;
  unchanged: number;
  written: number;
  failed: number;
  stopped?: string;
}

interface PendingLink { id: string; sourceId: string; targetId: string; relation: string; confidence: number }
interface Row { id: string; title: string; summary: string; platform: string | null; decided_at: string | null }

function pendingLinks(dbPath: string): { links: PendingLink[]; decision: (id: string) => Row | undefined } {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA busy_timeout = 30000');
    const links = raw.prepare(
      `SELECT l.id, l.source_id AS sourceId, l.target_id AS targetId, l.relation, l.confidence FROM decision_links l
       WHERE l.detector_version = 'v0' AND l.id NOT LIKE 'mark:%'
         AND EXISTS (SELECT 1 FROM decisions s WHERE s.id = l.source_id)
         AND EXISTS (SELECT 1 FROM decisions t WHERE t.id = l.target_id)
         AND NOT EXISTS (SELECT 1 FROM decision_links v WHERE v.detector_version = 'v1'
           AND ((v.source_id = l.source_id AND v.target_id = l.target_id) OR (v.source_id = l.target_id AND v.target_id = l.source_id)))
       ORDER BY l.rowid`,
    ).all() as unknown as PendingLink[];
    const rows = new Map((raw.prepare('SELECT id, title, summary, platform, decided_at FROM decisions').all() as unknown as Row[]).map((r) => [r.id, r]));
    return { links, decision: (id) => rows.get(id) };
  } finally {
    raw.close();
  }
}

export async function relinkWithV1(dbPath: string, opts: RelinkOptions, classify: typeof classifyCandidateSet = classifyCandidateSet): Promise<RelinkReport> {
  createLocalDb(dbPath).close(); // migrate to v12 before reading detector_version
  const { links, decision } = pendingLinks(dbPath);
  const bySource = new Map<string, PendingLink[]>();
  for (const l of links) bySource.set(l.sourceId, [...(bySource.get(l.sourceId) ?? []), l]);
  const sourceIds = [...bySource.keys()];
  const chosen = opts.limit === undefined ? sourceIds : sourceIds.slice(0, Math.max(0, opts.limit));
  const report: RelinkReport = { sources: 0, remainingSources: sourceIds.length - chosen.length, calls: 0, changes: [], unchanged: 0, written: 0, failed: 0 };

  const db = opts.apply ? createLocalDb(dbPath) : null;
  try {
    for (const sourceId of chosen) {
      const source = decision(sourceId)!;
      const pairs = bySource.get(sourceId)!;
      const candidates: SetCandidate[] = pairs.map((l) => {
        const t = decision(l.targetId)!;
        return { id: t.id, title: t.title, summary: t.summary, similarity: l.confidence, platform: t.platform, decidedAt: t.decided_at };
      });
      report.sources += 1;
      report.calls += 1;
      const result = await classify({ title: source.title, summary: source.summary, decidedAt: source.decided_at, platform: source.platform }, candidates);
      if (!result.ok) {
        report.failed += 1;
        if (result.failure?.kind === 'provider_stopped') {
          report.stopped = `${result.failure.model} (${result.failure.provider}) stopped answering: ${result.failure.detail}`;
          break;
        }
        continue;
      }
      pairs.forEach((l, i) => {
        const verdict = result.verdicts[i]!;
        const to = verdict.relation ?? 'relates';
        const confidence = verdict.relation === null ? l.confidence : verdict.confidence;
        const changed = to !== l.relation;
        if (changed) report.changes.push({ sourceId, targetId: l.targetId, from: l.relation, to });
        else report.unchanged += 1;
        if (!db) return;
        const link = { sourceId, targetId: l.targetId, relation: to, confidence, detectorVersion: 'v1' as const };
        if (opts.replace) {
          db.replaceLink(link);
          report.written += 1;
        } else if (changed) {
          db.insertLink(link);
          report.written += 1;
        }
      });
    }
  } finally {
    db?.close();
  }
  return report;
}
