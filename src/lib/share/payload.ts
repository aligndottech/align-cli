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
 * - the local id as such: `client_key` is an OPAQUE key, a hash of this install's secret salt and the id (see
 *   clientKeyFor), stored at the first share and reused, so the team graph cannot link a share back to a local id.
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
  /** Sent explicitly: the server keeps the caller's summary only when it is given (its extraction may rewrite the title). */
  summary: string;
  raw_text: string;
  client_key: string;
  created_at?: string;
  judgements: WireJudgement[];
}

/** A judgement as the preview lists it: the wire form plus what a person needs to read it. */
export interface ShownJudgement {
  wire: WireJudgement;
  /** Identity of this judgement for "already sent" (never includes the confirmation hash). */
  hash: string;
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
  /** Hash of the item AS SENT (only judgements not already sent). Binds a confirmation code. */
  hash: string;
  /** Hash of the item with EVERY judgement: what the ledger remembers, so an unchanged share is "already shared". */
  fullHash: string;
}

export interface BuildInput {
  row: DecisionRow;
  /** This judge's rows that name the decision (either end), tombstones already excluded by the reader. */
  judgements: JudgementRow[];
  /** The team graph's id for a local decision this machine already shared, if any. */
  remoteIdOf: (localId: string) => string | undefined;
  titleOf: (localId: string) => string | null;
  /** The opaque idempotency key: the one stored at the first share, else clientKeyFor(...). */
  clientKey: string;
  /** The install's private share salt, for the opaque local-only source URL. */
  salt: string;
  /** Hashes of judgements this workspace already stored; they are not sent (or shown) again. */
  alreadySent: ReadonlySet<string>;
}

/**
 * The idempotency key the server wants (a UUID), as an opaque hash of this install's secret salt and the
 * local id. The raw local id never leaves the machine and two installs cannot be linked by it. It is
 * derived ONCE: the caller stores it in the ledger at the first share and reuses that value, so a later
 * change of local id (a twin fold) cannot mint a second key and a second team decision.
 */
export function clientKeyFor(salt: string, localId: string): string {
  const h = createHash('sha256').update(`align-share-key\n${salt}\n${localId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * A local row with no source URL still needs one on the wire. The raw local id never leaves the machine, so it is
 * `align-local://decision/<hash of the share salt and the id>`. Matching by source key ignores this form (it names
 * no connector item), and the server's identity for a share is (workspace, user, client_key), not the URL, so
 * changing this form from the older raw-id one cannot mint a second team decision for a decision shared before.
 */
export function shareSourceUrl(row: { id: string; sourceUrl: string | null }, salt: string): string {
  if (row.sourceUrl !== null) return row.sourceUrl;
  return `align-local://decision/${createHash('sha256').update(`align-share-url\n${salt}\n${row.id}`).digest('hex').slice(0, 32)}`;
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

/** A judgement's identity for "already sent": its wire form without the confirmation hash. */
export function judgementHash(w: WireJudgement): string {
  const { confirm_team_text_hash: _c, ...rest } = w;
  return createHash('sha256').update(canonical(rest)).digest('hex');
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

function shownOf(wire: WireJudgement, via: 'cli' | 'mcp', agentId: string | null, counterpartTitle: string | null): ShownJudgement {
  return { wire, hash: judgementHash(wire), via, agentId, counterpartTitle };
}

export function buildSharePayload(input: BuildInput): SharePayload {
  const { row } = input;
  const shown: ShownJudgement[] = [];
  const leftLocal: LeftLocal[] = [];
  const deferredPairs: SharePayload['deferredPairs'] = [];

  if (row.ratifiedAt) {
    shown.push(shownOf({ kind: 'ratify', judged_at: row.ratifiedAt, origin: 'local_share' }, 'cli', null, null));
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
      shown.push(shownOf(wireFor(r, remote), r.via, r.agent_id, counterpartTitle));
      continue;
    }
    if (r.decision_id !== row.id) continue;
    shown.push(shownOf(wireFor(r), r.via, r.agent_id, null));
  }
  // Everything the person has judged, whether or not it was sent before: the ledger's "unchanged" test reads this.
  const everything = shown.map((x) => x.wire);
  // What is SENT (and shown): only what this workspace has not stored yet, so a note is never posted twice.
  const fresh = shown.filter((x) => !input.alreadySent.has(x.hash));
  // The gateway refuses a whole batch over the cap, so cut here: the ratification first, then the newest.
  let sending = fresh;
  if (fresh.length > MAX_SHARED_JUDGEMENTS) {
    const ratify = fresh.filter((x) => x.wire.kind === 'ratify');
    const rest = fresh.filter((x) => x.wire.kind !== 'ratify');
    const keep = new Set([...ratify, ...rest.slice(-(MAX_SHARED_JUDGEMENTS - ratify.length))]);
    for (const dropped of fresh.filter((x) => !keep.has(x))) leftLocal.push({ kind: dropped.wire.kind, why: 'over_limit', counterpartTitle: dropped.counterpartTitle });
    sending = fresh.filter((x) => keep.has(x));
  }
  const base = {
    source_url: shareSourceUrl(row, input.salt),
    platform: row.platform,
    title: row.title,
    summary: row.summary,
    raw_text: row.summary || row.title,
    client_key: input.clientKey,
    ...(row.decidedAt ? { created_at: row.decidedAt } : {}),
  };
  const item: WireItem = { ...base, judgements: sending.map((x) => x.wire) };
  return { localId: row.id, item, shown: sending, leftLocal, deferredPairs, hash: hashItem(item), fullHash: hashItem({ ...base, judgements: everything }) };
}

/**
 * The `decisions` array of POST /ingest/batch for share items: verbatim except the one rename `created_at` ->
 * `decided_at` (the gateway's schema takes the second and strips the first). The ONE place that rename happens
 * for a share: `shareBatch` (the typed path) and the sealed request (the browser path) both call it, so the
 * bytes a person approves are the bytes the gateway ingests.
 */
export function toBatchDecisions(items: ReadonlyArray<Record<string, unknown> & { created_at?: string }>): Array<Record<string, unknown>> {
  return items.map(({ created_at, ...rest }) => ({ ...rest, ...(created_at ? { decided_at: created_at } : {}) }));
}
