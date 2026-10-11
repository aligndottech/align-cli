/**
 * `align local relink --detector v1`: re-type existing v0 links with the v1 detector, explicitly.
 *
 * Schema v12 stamped every existing link 'v0' and nothing re-types a link silently, so this is
 * the one path that does. Its rules (review F1, F2, F5 of 2026-10-11):
 * - The unit is the UNORDERED PAIR. However many v0 rows a pair carries, in either direction, it
 *   is judged once, in one call, and appears once in that call. Pairs are grouped into calls by
 *   the source of the pair's earliest row (the NEW DECISION; its partners are the candidates).
 * - A pair a person has judged is never touched: any `local_judgements` row naming both
 *   decisions (a `replaces` mark, a conflict verdict), a `mark:` link on the pair, or a
 *   not-a-decision mark on either side. Judgements are read, not inferred from link ids, because
 *   a mark written over an existing classifier row keeps that row's id.
 * - A pair that already has a v1 row is skipped, so a second run does not pay for it again.
 * - An omitted verdict (the model gave the pair no relationship, or the resolver refused the
 *   edge) leaves the pair exactly as it is. Omission is not a verdict to apply.
 * - Candidates carry status 'superseded' when a decision OTHER than the pair's source supersedes
 *   them, so the prompt marks them RETIRED and the resolver refuses a verdict edge (R2: the
 *   pair's own row does not count).
 * - A pair carrying a supersedes is only changed by a conflict-family answer (R2); a
 *   non-conflict type leaves it as it is.
 * - Dry run (apply false) writes nothing. apply without replace adds a v1 row only where the
 *   type is new for the pair; apply with replace swaps the pair's non-mark rows for the v1 row.
 * - At most `maxCalls` calls; a failed call writes nothing for its group; a stopped provider ends
 *   the run. `written` lists only what was written.
 */
import { DatabaseSync } from 'node:sqlite';
import { buildV1SystemPrompt, buildV1UserPrompt, v1MaxTokens } from '../detector/relationship-prompt.js';
import { createLocalDb } from './local-db.js';
import { classifyCandidateSet, type SetCandidate } from './local-set-classifier.js';
import { estimateTokens } from './token-estimate.js';

export interface RelinkOptions { apply: boolean; replace: boolean; maxCalls: number }

export interface RelinkChange { sourceId: string; targetId: string; from: string[]; to: string }

export interface RelinkReport {
  calls: number;
  remainingCalls: number;
  proposed: RelinkChange[];
  written: RelinkChange[];
  unchanged: number;
  omitted: number;
  skippedJudged: number;
  /** Pairs carrying a classifier supersedes that v1 answered with a non-conflict type: left as they are (R2). */
  keptSupersedes: number;
  failed: number;
  stopped?: string;
}

interface Row { id: string; title: string; summary: string; platform: string | null; decided_at: string | null }
interface PendingPair { targetId: string; relations: string[]; confidence: number }
interface Group { sourceId: string; pairs: PendingPair[] }

export interface RelinkPlan {
  groups: Group[];
  decision: (id: string) => Row | undefined;
  /** Ids of the stored decisions that supersede this one. */
  supersededBy: (id: string) => ReadonlySet<string>;
  calls: number;
  pairs: number;
  skippedJudged: number;
  /** Estimated prompt tokens over every call (estimateTokens, the CLI's own estimator). */
  inputTokens: number;
  /** The max_tokens ceiling summed over every call: an upper bound on output. */
  maxOutputTokens: number;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** What relink would do, from the graph alone. No model call. */
export function planRelink(dbPath: string): RelinkPlan {
  createLocalDb(dbPath).close(); // migrate to v12 before reading detector_version
  const raw = new DatabaseSync(dbPath);
  let links: Array<{ id: string; sourceId: string; targetId: string; relation: string; confidence: number; v: string }>;
  let judged: Set<string>;
  let notDecisions: Set<string>;
  let rows: Map<string, Row>;
  try {
    raw.exec('PRAGMA busy_timeout = 30000');
    links = raw.prepare(
      `SELECT id, source_id AS sourceId, target_id AS targetId, relation, confidence, detector_version AS v FROM decision_links
       WHERE source_id <> target_id
         AND EXISTS (SELECT 1 FROM decisions s WHERE s.id = source_id) AND EXISTS (SELECT 1 FROM decisions t WHERE t.id = target_id)
       ORDER BY rowid`,
    ).all() as unknown as typeof links;
    const judgements = raw.prepare(`SELECT decision_id AS d, counterpart_id AS c, kind FROM local_judgements`).all() as Array<{ d: string; c: string | null; kind: string }>;
    judged = new Set(judgements.filter((j) => j.c !== null).map((j) => pairKey(j.d, j.c!)));
    notDecisions = new Set(judgements.filter((j) => j.kind === 'not_a_decision').map((j) => j.d));
    rows = new Map((raw.prepare('SELECT id, title, summary, platform, decided_at FROM decisions').all() as unknown as Row[]).map((r) => [r.id, r]));
  } finally {
    raw.close();
  }

  const blocked = new Set<string>();
  for (const l of links) {
    const key = pairKey(l.sourceId, l.targetId);
    if (l.v !== 'v0' || l.id.startsWith('mark:')) blocked.add(key);
  }
  const pairs = new Map<string, { sourceId: string; pair: PendingPair }>();
  const skipped = new Set<string>();
  for (const l of links) {
    const key = pairKey(l.sourceId, l.targetId);
    if (blocked.has(key)) {
      if (judged.has(key) || links.some((x) => x.id.startsWith('mark:') && pairKey(x.sourceId, x.targetId) === key)) skipped.add(key);
      continue;
    }
    if (judged.has(key) || notDecisions.has(l.sourceId) || notDecisions.has(l.targetId)) { skipped.add(key); continue; }
    const seen = pairs.get(key);
    if (seen) {
      if (!seen.pair.relations.includes(l.relation)) seen.pair.relations.push(l.relation);
      seen.pair.confidence = Math.max(seen.pair.confidence, l.confidence);
    } else {
      pairs.set(key, { sourceId: l.sourceId, pair: { targetId: l.targetId, relations: [l.relation], confidence: l.confidence } });
    }
  }
  const bySource = new Map<string, PendingPair[]>();
  for (const { sourceId, pair } of pairs.values()) bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), pair]);
  const groups = [...bySource.entries()].map(([sourceId, ps]) => ({ sourceId, pairs: ps.map((p) => ({ ...p, relations: [...p.relations].sort() })) }));

  const decision = (id: string): Row | undefined => rows.get(id);
  const supersessions = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.relation === 'supersedes' || l.relation === 'partially_supersedes') supersessions.set(l.targetId, (supersessions.get(l.targetId) ?? new Set()).add(l.sourceId));
  }
  const supersededBy = (id: string): ReadonlySet<string> => supersessions.get(id) ?? new Set();
  const system = estimateTokens(buildV1SystemPrompt());
  let inputTokens = 0;
  let maxOutputTokens = 0;
  for (const g of groups) {
    const out = v1MaxTokens(g.pairs.length);
    inputTokens += system + estimateTokens(buildV1UserPrompt(subjectOf(decision(g.sourceId)!), candidatesOf(g, decision, supersededBy), 1_000_000, out));
    maxOutputTokens += out;
  }
  return { groups, decision, supersededBy, calls: groups.length, pairs: pairs.size, skippedJudged: skipped.size, inputTokens, maxOutputTokens };
}

function subjectOf(r: Row) {
  return { title: r.title, summary: r.summary, decidedAt: r.decided_at, platform: r.platform };
}

/** Re-review R2: a candidate is RETIRED only when a decision OTHER than this pair's source
 *  supersedes it. The pair's own supersedes row is the thing under review; letting it mark the
 *  candidate retired would make the resolver refuse the very edge that confirms it. */
function candidatesOf(g: Group, decision: (id: string) => Row | undefined, supersededBy: (id: string) => ReadonlySet<string>): SetCandidate[] {
  return g.pairs.map((p) => {
    const t = decision(p.targetId)!;
    const retired = [...supersededBy(t.id)].some((s) => s !== g.sourceId);
    return { id: t.id, title: t.title, summary: t.summary, similarity: p.confidence, platform: t.platform, decidedAt: t.decided_at, status: retired ? 'superseded' : null };
  });
}

export async function relinkWithV1(dbPath: string, opts: RelinkOptions, classify: typeof classifyCandidateSet = classifyCandidateSet): Promise<RelinkReport> {
  const plan = planRelink(dbPath);
  const report: RelinkReport = { calls: 0, remainingCalls: 0, proposed: [], written: [], unchanged: 0, omitted: 0, skippedJudged: plan.skippedJudged, keptSupersedes: 0, failed: 0 };
  const db = opts.apply ? createLocalDb(dbPath) : null;
  try {
    for (const [gi, g] of plan.groups.entries()) {
      if (report.calls >= opts.maxCalls) { report.remainingCalls = plan.groups.length - gi; break; }
      report.calls += 1;
      const result = await classify(subjectOf(plan.decision(g.sourceId)!), candidatesOf(g, plan.decision, plan.supersededBy));
      if (!result.ok) {
        report.failed += 1;
        if (result.failure?.kind === 'provider_stopped') {
          report.stopped = `${result.failure.model} (${result.failure.provider}) stopped answering: ${result.failure.detail}`;
          report.remainingCalls = plan.groups.length - gi - 1;
          break;
        }
        continue;
      }
      g.pairs.forEach((p, i) => {
        const verdict = result.verdicts[i]!;
        if (verdict.relation === null) { report.omitted += 1; return; }
        // R2: a supersedes is only overturned by a conflict-family answer; anything else leaves it.
        if (p.relations.includes('supersedes') && !['supersedes', 'conflicts_with', 'contradicts'].includes(verdict.relation)) {
          report.keptSupersedes += 1;
          return;
        }
        const change: RelinkChange = { sourceId: g.sourceId, targetId: p.targetId, from: p.relations, to: verdict.relation };
        const isNew = !p.relations.includes(verdict.relation);
        if (isNew) report.proposed.push(change);
        else report.unchanged += 1;
        if (!db || (!opts.replace && !isNew)) return;
        const link = { sourceId: g.sourceId, targetId: p.targetId, relation: verdict.relation, confidence: verdict.confidence, detectorVersion: 'v1' as const };
        if (opts.replace) db.replaceLink(link);
        else db.insertLink(link);
        report.written.push(change);
      });
    }
  } finally {
    db?.close();
  }
  return report;
}
