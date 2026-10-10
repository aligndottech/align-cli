/**
 * L5, Decision 1: `align sync --classify --max N`, the ONLY path that types imported items.
 *
 * Background sync, backfill and every connector import write free `relates` links and never call
 * the paid classifier. This is the on-demand half: the person runs it, sees an estimate first, and
 * confirms (the command asks; `align_sync` can only ESTIMATE). It classifies the same high-confidence
 * candidates ingestOne would have (score >= SIMILARITY_THRESHOLD, at most CAPTURE_CLASSIFY_TOP_K per
 * item), writes through the existing `replaceLink`, and works newest first.
 *
 * "Unclassified" means: has at least one high-confidence `relates` edge as its source, no typed
 * edge on either side, and was not already attempted. The attempt is recorded as an audit note
 * (`sync_classified`) because a classifier verdict of `relates` writes `relates` again, which looks
 * identical to never having been asked: without the note every run would pay for the same items.
 */
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../local-db.js';
import { CAPTURE_CLASSIFY_TOP_K } from '../local-ingest.js';
import { hasConfiguredProvider, preferredProvider } from '../local-llm.js';
import { PROVIDER_LABEL } from '../llm-providers.js';
import { type ClassificationOutcome, classifyRelationship } from '../local-relationship-classifier.js';
import { SIMILARITY_THRESHOLD } from '../local-thresholds.js';

export const CLASSIFY_AUDIT_ACTION = 'sync_classified';

export interface Unclassified { id: string; title: string; summary: string }

export function unclassifiedItems(dbPath: string, limit: number): Unclassified[] {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    return db.prepare(
      `SELECT d.id AS id, d.title AS title, d.summary AS summary FROM decisions d
       WHERE EXISTS (SELECT 1 FROM decision_links l WHERE l.source_id = d.id AND l.relation = 'relates' AND l.confidence >= ?)
         AND NOT EXISTS (SELECT 1 FROM decision_links t WHERE (t.source_id = d.id OR t.target_id = d.id) AND t.relation <> 'relates')
         AND NOT EXISTS (SELECT 1 FROM decision_audit a WHERE a.decision_id = d.id AND a.action = ?)
       ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    ).all(SIMILARITY_THRESHOLD, CLASSIFY_AUDIT_ACTION, limit) as unknown as Unclassified[];
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return [];
    throw e;
  } finally {
    db.close();
  }
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
  const out: ClassifyResult = { items: 0, calls: 0, typed: 0, unparsed: 0 };
  try {
    for (const item of unclassifiedItems(dbPath, Math.max(0, max))) {
      const candidates = db.listLinks({ relation: 'relates', decisionId: item.id })
        .filter((l) => l.sourceId === item.id && l.confidence >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, CAPTURE_CLASSIFY_TOP_K);
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
    db.close();
  }
  return out;
}
