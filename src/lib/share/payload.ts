/**
 * L9: the ONE builder of what `align share` sends. The preview, the confirmation code's hash and
 * the request body all come from the object this returns, so the preview cannot show something other
 * than what is sent (a test compares the previewed JSON with the ingest argument).
 *
 * What leaves the machine, per decision: the title, the text (the summary, sent as `raw_text`), the
 * source URL and platform, when it was decided, and the judgements below. What never does:
 * - `judge_id` and `judge_label` (the git email): the server takes the person from the token, and a
 *   label is personal data nobody asked for (Decision 11).
 * - `context_key`, file paths, or a check verdict's scope: a check verdict goes as kind, value, time.
 * - the local id as such: `client_key` is a UUID derived from it, the idempotency key.
 * - a verdict whose other decision is not on the team graph (it stays local, and the preview says so).
 * - a tombstone (a verdict taken back, `value` NULL): the person withdrew it.
 *
 * Judgement mapping: local `real` is `true_positive`, `false` is `false_positive`. Ratification is
 * read from the decision's own columns (Decision 14), never from `local_judgements`. A row an agent
 * relayed goes as `origin: local_share_mcp` with the registry id as `agent`; the id 'unknown' is omitted.
 */
import { createHash } from 'node:crypto';
import type { DecisionRow } from '../local-db.js';
import type { JudgementRow } from '../curation/judgements-db.js';

/** The gateway's per-item cap (MAX_JUDGEMENTS_PER_ITEM). Over it the batch is refused whole, so we cut first. */
export const MAX_SHARED_JUDGEMENTS = 50;

export type WireKind = 'ratify' | 'conflict_verdict' | 'check_verdict' | 'supersede' | 'not_a_decision' | 'note';

export interface WireJudgement {
  kind: WireKind;
  value?: 'true_positive' | 'false_positive';
  note?: string;
  counterpart_id?: string;
  judged_at: string;
  origin: 'local_share' | 'local_share_mcp';
  agent?: string;
  confirm_team_text_hash?: string;
}

export interface WireItem {
  source_url: string;
  platform: string;
  title: string;
  raw_text: string;
  client_key: string;
  created_at?: string;
  judgements: WireJudgement[];
}

/** A judgement as the preview lists it: the wire form plus what a person needs to read it. */
export interface ShownJudgement {
  wire: WireJudgement;
  via: 'cli' | 'mcp';
  agentId: string | null;
  counterpartTitle: string | null;
}

export interface LeftLocal {
  kind: WireKind;
  why: 'counterpart_not_shared' | 'over_limit';
  counterpartTitle: string | null;
}

export interface SharePayload {
  localId: string;
  item: WireItem;
  shown: ShownJudgement[];
  leftLocal: LeftLocal[];
  /** Pair judgements whose counterpart is not on the team graph YET: sendable once it is. */
  deferredPairs: Array<{ row: JudgementRow; counterpartLocalId: string }>;
  hash: string;
}

export interface BuildInput {
  row: DecisionRow;
  /** This judge's rows that name the decision (either end), tombstones already excluded by the reader. */
  judgements: JudgementRow[];
  /** The team graph's id for a local decision this machine already shared, if any. */
  remoteIdOf: (localId: string) => string | undefined;
  titleOf: (localId: string) => string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The idempotency key the server wants: a UUID. A local id that is one is used as is. */
export function clientKeyFor(localId: string): string {
  if (UUID.test(localId)) return localId.toLowerCase();
  const h = createHash('sha256').update(`align-local-decision\n${localId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A local row with no source URL still needs a stable one on the wire: the local id is the only identity it has. */
export function shareSourceUrl(row: { id: string; sourceUrl: string | null }): string {
  return row.sourceUrl ?? `align-local://decision/${row.id}`;
}

const VALUE: Record<string, 'true_positive' | 'false_positive'> = { real: 'true_positive', false: 'false_positive' };

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** sha256 of the item with its keys sorted: the same payload hashes the same wherever it was built. */
export function hashItem(item: WireItem): string {
  return createHash('sha256').update(canonical(item)).digest('hex');
}

function wireFor(r: JudgementRow, counterpart?: string): WireJudgement {
  const mcp = r.via === 'mcp';
  const agent = mcp && r.agent_id && r.agent_id !== 'unknown' ? r.agent_id : undefined;
  return {
    kind: r.kind,
    ...(r.value ? { value: VALUE[r.value] } : {}),
    ...(r.kind === 'note' && r.note ? { note: r.note } : {}),
    ...(counterpart ? { counterpart_id: counterpart } : {}),
    judged_at: r.judged_at,
    origin: mcp ? 'local_share_mcp' : 'local_share',
    ...(agent ? { agent } : {}),
  };
}

export function buildSharePayload(input: BuildInput): SharePayload {
  const { row } = input;
  const shown: ShownJudgement[] = [];
  const leftLocal: LeftLocal[] = [];
  const deferredPairs: SharePayload['deferredPairs'] = [];

  if (row.ratifiedAt) {
    shown.push({
      wire: { kind: 'ratify', judged_at: row.ratifiedAt, origin: 'local_share' },
      via: 'cli', agentId: null, counterpartTitle: null,
    });
  }
  const rows = [...input.judgements].sort((a, b) => (a.judged_at < b.judged_at ? -1 : a.judged_at > b.judged_at ? 1 : a.id < b.id ? -1 : 1));
  for (const r of rows) {
    // A withdrawn verdict is no verdict, whatever reader produced the list.
    if (r.value === null && (r.kind === 'conflict_verdict' || r.kind === 'check_verdict')) continue;
    if (r.kind === 'conflict_verdict' || r.kind === 'supersede') {
      if (r.counterpart_id === null) continue;
      // A supersede is directional: "decision_id replaces counterpart_id". It travels with the NEWER decision's share.
      if (r.kind === 'supersede' && r.decision_id !== row.id) continue;
      const other = r.decision_id === row.id ? r.counterpart_id : r.decision_id;
      const remote = input.remoteIdOf(other);
      const counterpartTitle = input.titleOf(other);
      if (!remote) {
        leftLocal.push({ kind: r.kind, why: 'counterpart_not_shared', counterpartTitle });
        deferredPairs.push({ row: r, counterpartLocalId: other });
        continue;
      }
      shown.push({ wire: wireFor(r, remote), via: r.via, agentId: r.agent_id, counterpartTitle });
      continue;
    }
    if (r.decision_id !== row.id) continue;
    shown.push({ wire: wireFor(r), via: r.via, agentId: r.agent_id, counterpartTitle: null });
  }
  // The gateway refuses a whole batch over the cap, so cut here: the ratification first, then the newest.
  if (shown.length > MAX_SHARED_JUDGEMENTS) {
    const keep = [shown[0]!, ...shown.slice(1).slice(-(MAX_SHARED_JUDGEMENTS - 1))];
    for (const dropped of shown.filter((s) => !keep.includes(s))) leftLocal.push({ kind: dropped.wire.kind, why: 'over_limit', counterpartTitle: dropped.counterpartTitle });
    shown.splice(0, shown.length, ...keep);
  }
  const item: WireItem = {
    source_url: shareSourceUrl(row),
    platform: row.platform,
    title: row.title,
    raw_text: row.summary || row.title,
    client_key: clientKeyFor(row.id),
    ...(row.decidedAt ? { created_at: row.decidedAt } : {}),
    judgements: shown.map((s) => s.wire),
  };
  return { localId: row.id, item, shown, leftLocal, deferredPairs, hash: hashItem(item) };
}
