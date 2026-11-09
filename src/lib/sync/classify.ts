/**
 * L5, Decision 1: typing imported items with the person's own model. Connector imports, backfill and
 * the sync itself write free `relates` links and never call the classifier. Two callers type them:
 * `align sync --classify --max N`, which shows an estimate and asks, and the background refresh, but
 * only after the person said yes once (`align sync --auto-classify on`, or the question at the end of
 * setup), and then at most BACKGROUND_CLASSIFY_MAX items per refresh.
 *
 * Candidates are every stored `relates` link the item is the source of, not only the ones at the
 * 0.65 floor: links between tools mostly score 0.45 to 0.62 and are stored by the top-K rule
 * (local-thresholds.ts, RELATED_FLOOR), so the old floor skipped almost every cross-tool pair. Pairs
 * that cross tools go first, then by score, at most CAPTURE_CLASSIFY_TOP_K per item. Writes go
 * through `replaceLink`, and work runs newest first.
 *
 * "Unclassified" means: has at least one high-confidence `relates` edge as its source, no typed
 * edge on either side, and was not already attempted. The attempt is recorded as an audit note
 * (`sync_classified`) because a classifier verdict of `relates` writes `relates` again, which looks
 * identical to never having been asked: without the note every run would pay for the same items.
 */
import { DatabaseSync } from 'node:sqlite';
import { tightenGraphFiles } from '../private-files.js';
import { createLocalDb } from '../local-db.js';
import { CAPTURE_CLASSIFY_TOP_K } from '../local-ingest.js';
import { hasConfiguredProvider, preferredProvider } from '../local-llm.js';
import { PROVIDER_LABEL } from '../llm-providers.js';
import { type ClassificationOutcome, classifyRelationship } from '../local-relationship-classifier.js';
import { RELATED_FLOOR } from '../local-thresholds.js';

export const CLASSIFY_AUDIT_ACTION = 'sync_classified';
/** How many items one background refresh types, at most. Each is up to CAPTURE_CLASSIFY_TOP_K calls. */
export const BACKGROUND_CLASSIFY_MAX = 10;

export interface Unclassified { id: string; title: string; summary: string; platform: string }

export function unclassifiedItems(dbPath: string, limit: number): Unclassified[] {
  tightenGraphFiles(dbPath); // owner-only on every open (private-files.ts)
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    return db.prepare(
      `SELECT d.id AS id, d.title AS title, d.summary AS summary, d.platform AS platform FROM decisions d
       WHERE EXISTS (SELECT 1 FROM decision_links l WHERE l.source_id = d.id AND l.relation = 'relates' AND l.confidence >= ? AND l.detector_version <> 'ref')
         AND NOT EXISTS (SELECT 1 FROM decision_links t WHERE (t.source_id = d.id OR t.target_id = d.id) AND t.relation <> 'relates')
         AND NOT EXISTS (SELECT 1 FROM decision_audit a WHERE a.decision_id = d.id AND a.action = ?)
       ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    ).all(RELATED_FLOOR, CLASSIFY_AUDIT_ACTION, limit) as unknown as Unclassified[];
  } catch (e) {
    if (/no such (table|column)/i.test((e as Error).message)) return [];
    throw e;
  } finally {
    db.close();
  }
}

/**
 * An item's candidates: its own `relates` links at or above the link floor, cross-tool first, then
 * by score. Two kinds are never sent to the model: a certain reference link ('ref', already known),
 * and a pair a person has judged (a conflict marked false, a replacement), which an unattended run
 * must not re-raise.
 */
function candidatesFor(raw: DatabaseSync, item: Unclassified, judged: boolean): Array<{ targetId: string }> {
  const rows = raw.prepare(
    `SELECT l.target_id AS targetId, l.confidence AS confidence, d.platform AS platform FROM decision_links l JOIN decisions d ON d.id = l.target_id
      WHERE l.source_id = ? AND l.relation = 'relates' AND l.confidence >= ? AND l.detector_version <> 'ref'${judged ? `
        AND NOT EXISTS (SELECT 1 FROM local_judgements j WHERE (j.decision_id = l.source_id AND j.counterpart_id = l.target_id) OR (j.decision_id = l.target_id AND j.counterpart_id = l.source_id))` : ''}`,
  ).all(item.id, RELATED_FLOOR) as Array<{ targetId: string; confidence: number; platform: string | null }>;
  const crosses = (p: string | null): number => ((p ?? null) !== (item.platform ?? null) ? 1 : 0);
  return rows.sort((a, b) => crosses(b.platform) - crosses(a.platform) || b.confidence - a.confidence).slice(0, CAPTURE_CLASSIFY_TOP_K);
}

export interface Estimate {
  /** Items that would be classified: min(max, unclassified). */
  items: number;
  /** Upper bound on LLM calls: items x CAPTURE_CLASSIFY_TOP_K. */
  calls: number;
  /** How many unclassified items exist in all. */
  available: number;
  /** "Anthropic", "Ollama"... or undefined when none is configured. */
  provider: string | undefined;
}

export function estimateClassify(dbPath: string, max: number): Estimate {
  const available = unclassifiedItems(dbPath, Number.MAX_SAFE_INTEGER).length;
  const items = Math.min(Math.max(0, max), available);
  const configured = hasConfiguredProvider();
  const preferred = preferredProvider();
  return { items, calls: items * CAPTURE_CLASSIFY_TOP_K, available, provider: configured ? (preferred ? PROVIDER_LABEL[preferred] : 'configured AI provider') : undefined };
}

export interface ClassifyResult { items: number; calls: number; typed: number; unparsed: number; stopped?: string }

export async function classifyUnclassified(
  dbPath: string,
  max: number,
  classify: (a: { title: string; summary: string }, b: { title: string; summary: string }) => Promise<ClassificationOutcome> = classifyRelationship,
): Promise<ClassifyResult> {
  const db = createLocalDb(dbPath);
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA busy_timeout = 30000');
  const judged = raw.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'local_judgements'`).get() !== undefined;
  const out: ClassifyResult = { items: 0, calls: 0, typed: 0, unparsed: 0 };
  try {
    for (const item of unclassifiedItems(dbPath, Math.max(0, max))) {
      const candidates = candidatesFor(raw, item, judged);
      let stopped = false;
      for (const l of candidates) {
        const existing = db.getDecisionById(l.targetId);
        if (!existing) continue;
        out.calls += 1;
        // Same direction as the capture-time pass: the EXISTING decision is the subject, this item the candidate.
        const r = await classify({ title: existing.title, summary: existing.summary }, { title: item.title, summary: item.summary });
        if (r.ok) {
          db.replaceLink({ sourceId: item.id, targetId: l.targetId, relation: r.relationship.type, confidence: r.relationship.confidence });
          out.typed += 1;
        } else if (r.failure?.kind === 'provider_stopped') {
          stopped = true;
          out.stopped = 'the AI provider stopped answering (a bad key, no credit or a rate limit)';
          break;
        } else {
          out.unparsed += 1;
        }
      }
      // A stopped provider says nothing about this item, so it stays eligible for the next run.
      if (stopped) break;
      db.insertAudit({ decisionId: item.id, action: CLASSIFY_AUDIT_ACTION, actor: null });
      out.items += 1;
    }
  } finally {
    raw.close();
    db.close();
  }
  return out;
}
