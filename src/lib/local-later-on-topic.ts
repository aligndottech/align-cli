import type { DecisionRow, LinkRow } from './local-db.js';

/**
 * Local half of the cloud's `later_on_topic` (align-stack db/laterOnTopic.ts): up to 3 decisions
 * LATER than a search hit that sit on the same topic, linked or merely similar. It is what tells an
 * agent "something newer exists" when no supersedes edge was ever written - the normal state of a
 * graph built with no AI key, where nothing types a relation and every link is `relates`.
 *
 * Dated by `decided_at` (the source's own moment, e.g. the commit date), falling back to
 * `created_at` only when a row has none. created_at is the ingest minute: a whole git history
 * imported at once shares one, so ordering by it makes every commit "equally old" and nothing is later.
 */
export const LATER_ON_TOPIC_MAX = 3;
/**
 * A later decision counts as "on the topic" only if it and the hit are MUTUAL nearest neighbours:
 * the later one is within the hit's closest K, and the hit is within the later one's closest K.
 * An absolute floor cannot do this (measured on a real graph: on-topic links scored 0.55-0.77,
 * off-topic 0.51-0.68), but rank is relative. An off-topic row at 0.6 has closer neighbours of its
 * own, so it fails the second half, and the newest decision, with nothing later near it, gets none.
 */
export const LATER_MUTUAL_RANK = 5;

export interface LaterOnTopicEntry {
  /** Assignable to the wire's DecisionRelation, which is an open record. */
  [key: string]: unknown;
  id: string;
  title: string;
  source_url?: string;
  date: string;
  date_basis: 'decided' | 'recorded';
  /** Cosine to the hit; absent for an entry found only through a typed edge. */
  similarity?: number;
  relation?: string;
}

/** The row's own date as epoch ms, and which clock supplied it. */
export function dateOf(row: Pick<DecisionRow, 'decidedAt' | 'createdAt'>): { ms: number; iso: string; basis: 'decided' | 'recorded' } | null {
  const decided = row.decidedAt ? Date.parse(row.decidedAt) : NaN;
  if (!Number.isNaN(decided)) return { ms: decided, iso: new Date(decided).toISOString(), basis: 'decided' };
  // SQLite's datetime('now') default is 'YYYY-MM-DD HH:MM:SS', UTC, no offset.
  const raw = row.createdAt.includes('T') ? row.createdAt : `${row.createdAt.replace(' ', 'T')}Z`;
  const created = Date.parse(raw);
  return Number.isNaN(created) ? null : { ms: created, iso: new Date(created).toISOString(), basis: 'recorded' };
}

export function laterOnTopic(opts: {
  hit: DecisionRow;
  /** Every candidate in scope with its cosine to the hit (the hit itself excluded by the caller). */
  neighbours: ReadonlyArray<{ decisionId: string; score: number }>;
  linksOfHit: readonly LinkRow[];
  rowById: (id: string) => DecisionRow | null;
  threshold: number;
  /** 1-based rank of `hitId` among `id`'s own neighbours by cosine. Absent: no reverse check. */
  rankOfHitIn?: (id: string) => number;
}): LaterOnTopicEntry[] {
  const hitDate = dateOf(opts.hit);
  if (!hitDate) return [];
  const out = new Map<string, LaterOnTopicEntry & { ms: number }>();
  const consider = (id: string, similarity: number | undefined, relation: string | undefined) => {
    if (id === opts.hit.id) return;
    const row = opts.rowById(id);
    const d = row ? dateOf(row) : null;
    // Strictly later, on the date each row carries. Equal or earlier is not "later on the topic".
    if (!row || !d || d.ms <= hitDate.ms) return;
    // An ingest minute is not comparable to a source date: an undated row imported today is "later"
    // than every commit, which says nothing about the topic. Compare like with like.
    if (hitDate.basis === 'decided' && d.basis === 'recorded') return;
    const prior = out.get(id);
    out.set(id, {
      id, title: row.title,
      ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
      date: d.iso, date_basis: d.basis, ms: d.ms,
      ...(similarity !== undefined ? { similarity } : prior?.similarity !== undefined ? { similarity: prior.similarity } : {}),
      ...(relation ? { relation } : prior?.relation ? { relation: prior.relation } : {}),
    });
  };
  // A typed edge counts at any similarity: a person or a classifier said these are the same topic.
  for (const l of opts.linksOfHit) {
    if (l.relation === 'relates' || l.relation === 'relates_to') continue; // an untyped similarity link, re-found below on its score
    consider(l.sourceId === opts.hit.id ? l.targetId : l.sourceId, undefined, l.relation);
  }
  const byScore = [...opts.neighbours].sort((a, b) => b.score - a.score);
  const closest = new Set(byScore.slice(0, LATER_MUTUAL_RANK).map(n => n.decisionId));
  for (const n of opts.neighbours) {
    if (n.score < opts.threshold || !closest.has(n.decisionId)) continue;
    if (opts.rankOfHitIn && opts.rankOfHitIn(n.decisionId) > LATER_MUTUAL_RANK) continue;
    consider(n.decisionId, n.score, undefined);
  }
  const typed = (e: LaterOnTopicEntry) => (e.relation ? 0 : 1);
  return [...out.values()]
    // Typed first, then the most similar, then the earliest date; id last so the cut is deterministic.
    .sort((a, b) => typed(a) - typed(b) || (b.similarity ?? 0) - (a.similarity ?? 0) || a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, LATER_ON_TOPIC_MAX)
    .map(({ ms: _ms, ...e }) => e);
}
