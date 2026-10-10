/**
 * L9: the shape POST /ingest/batch answers a SHARE with, read without trusting it.
 *
 * The response is not one snapshot per request item. It carries `snapshots` for what was WRITTEN
 * (each with `request_index`, its position in the request), and the rest by index: `matched`
 * (attached to a decision the team already held, nothing created), `skipped` (a re-share left alone),
 * `refused` (the identity belongs to a decision the caller cannot see), `match_ambiguous` (several
 * team decisions share the source key, so the item was created as new) and `judgements` (one report
 * per target, one result per judgement). Reading `snapshots[0]` as "the decision I shared" is wrong
 * whenever any of those is present. This module turns the response into exactly one outcome per
 * request item, and an item the response never mentions is `unknown`, never "created".
 */
export interface JudgementResult { ok: boolean; stored?: boolean; error?: string }

export interface BatchResponse {
  snapshots?: Array<{ id: string; title?: string; summary?: string; request_index?: number; is_new?: boolean }>;
  skipped?: Array<{ index: number; reason: string; existing_id: string }>;
  matched?: Array<{
    request_index: number; existing_id: string; status?: string; team_text_hash?: string;
    needs_confirmation?: Array<{ kind: string; judgement_index: number }>;
  }>;
  match_ambiguous?: number[];
  refused?: Array<{ request_index: number; reason: string }>;
  judgements?: Array<{ request_index: number; decision_id: string; results: JudgementResult[] }>;
}

export interface JudgementFailure { index: number; error: string }

interface Common {
  index: number;
  /** One result per judgement sent, or null when the gateway reported none (an older gateway ignores the field). */
  judgements: JudgementResult[] | null;
}

export type ItemOutcome =
  | (Common & { kind: 'created'; remoteId: string; ambiguous: boolean })
  | (Common & { kind: 'updated'; remoteId: string })
  | (Common & { kind: 'matched'; remoteId: string; status: string; teamTextHash: string | null; needsConfirmation: Array<{ kind: string; judgement_index: number }> })
  | (Common & { kind: 'skipped'; remoteId: string; reason: string })
  | { kind: 'refused'; index: number; reason: string }
  | { kind: 'unknown'; index: number };

export function failedJudgements(results: JudgementResult[] | null): JudgementFailure[] {
  return (results ?? []).flatMap((r, index) => (r.ok ? [] : [{ index, error: r.error ?? 'failed' }]));
}

/**
 * One outcome per request item. `sent` is how many items the request carried. A response whose
 * snapshots carry no `request_index` (a gateway before the field) is index-aligned ONLY when nothing
 * was matched, skipped or refused and the counts agree; otherwise those items are `unknown`.
 */
export function readOutcomes(sent: number, res: BatchResponse): ItemOutcome[] {
  const snapshots = res.snapshots ?? [];
  const judged = new Map((res.judgements ?? []).map((j) => [j.request_index, j.results] as const));
  const reportFor = (index: number): JudgementResult[] | null => judged.get(index) ?? null;
  const ambiguous = new Set(res.match_ambiguous ?? []);
  const out = new Map<number, ItemOutcome>();

  for (const r of res.refused ?? []) out.set(r.request_index, { kind: 'refused', index: r.request_index, reason: r.reason });
  for (const m of res.matched ?? []) {
    out.set(m.request_index, {
      kind: 'matched', index: m.request_index, remoteId: m.existing_id, status: m.status ?? 'unknown',
      teamTextHash: m.team_text_hash ?? null, needsConfirmation: m.needs_confirmation ?? [], judgements: reportFor(m.request_index),
    });
  }
  for (const s of res.skipped ?? []) {
    out.set(s.index, { kind: 'skipped', index: s.index, remoteId: s.existing_id, reason: s.reason, judgements: reportFor(s.index) });
  }
  const untagged = snapshots.some((s) => s.request_index === undefined);
  const aligned = untagged && snapshots.length === sent && out.size === 0;
  snapshots.forEach((s, k) => {
    const index = s.request_index ?? (aligned ? k : undefined);
    if (index === undefined || out.has(index)) return;
    out.set(index, s.is_new === false
      ? { kind: 'updated', index, remoteId: s.id, judgements: reportFor(index) }
      : { kind: 'created', index, remoteId: s.id, ambiguous: ambiguous.has(index), judgements: reportFor(index) });
  });
  return Array.from({ length: sent }, (_, index) => out.get(index) ?? { kind: 'unknown' as const, index });
}
