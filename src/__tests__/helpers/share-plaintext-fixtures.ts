/**
 * The cross-repo contract fixtures for the sealed share plaintext (ALI-1540). Built from the REAL code
 * (buildSharePayload for the items, buildPlaintext for the bytes), never hand-written JSON, so the gateway and the
 * approve page can test against exactly what this CLI would seal. Deterministic: fixed salt, ids and dates.
 */
import { createHash } from 'node:crypto';
import type { JudgementRow } from '../../lib/curation/judgements-db.js';
import { buildPlaintext, type RequestKind } from '../../lib/share/envelope.js';
import { buildSharePayload, clientKeyFor, type SharePayload } from '../../lib/share/payload.js';
import type { DecisionRow } from '../../lib/local-db.js';

const TENANT = 'tenant-fixture-1';
const USER = 'user-fixture-1';
const GATEWAY = 'https://api.align.test';
const SALT = 'fixture-salt';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const row = (n: number, over: Partial<DecisionRow> = {}): DecisionRow => ({
  id: uuid(n), title: `Decision ${n}`, summary: `Summary of decision ${n}.`, sourceUrl: `https://github.com/o/r/pull/${n}`, platform: 'github',
  createdAt: '2026-09-01T00:00:00.000Z', decidedAt: '2026-09-02T09:00:00.000Z', repo: null, deciderKind: 'human', confirmedBy: null, confirmedAt: null,
  ratifiedBy: 'me@example.test', ratifiedAt: '2026-09-03T10:00:00.000Z', ...over,
});
const jr = (id: string, over: Partial<JudgementRow>): JudgementRow => ({
  id, decision_id: uuid(1), counterpart_id: null, context_key: null, kind: 'note', value: null, note: null, judge_id: 'inst-1', judge_label: 'me@example.test',
  via: 'cli', agent_id: null, judged_at: '2026-09-04T10:00:00.000Z', ...over,
});
const payload = (r: DecisionRow, judgements: JudgementRow[] = [], remote: Record<string, string> = {}): SharePayload =>
  buildSharePayload({ row: r, judgements, remoteIdOf: (id) => remote[id], titleOf: (id) => `Title of ${id.slice(-2)}`, clientKey: clientKeyFor(SALT, r.id), salt: SALT, alreadySent: new Set() });

export interface Fixture {
  name: string;
  kind: RequestKind;
  tenant_id: string;
  user_id: string;
  envelope_id: string;
  plaintext_json: string;
  plaintext_sha256: string;
  /** The union of top-level keys on the `decisions` items. */
  expected_item_fields: string[];
  /** The union of keys on every judgement inside those items. */
  expected_judgement_fields: string[];
  /** The top-level keys of the plaintext itself. */
  expected_top_level_fields: string[];
}

function fixture(name: string, kind: RequestKind, envelopeN: number, payloads: SharePayload[], confirm?: { remoteId: string; teamTextHash: string }): Fixture {
  const bytes = buildPlaintext({ kind, tenantId: TENANT, gatewayUrl: GATEWAY, payloads, ...(confirm ? { confirm } : {}) });
  const parsed = JSON.parse(bytes.toString('utf8')) as { decisions: Array<Record<string, unknown> & { judgements: Array<Record<string, unknown>> }> } & Record<string, unknown>;
  const union = (xs: Array<Record<string, unknown>>): string[] => [...new Set(xs.flatMap((x) => Object.keys(x)))].sort();
  return {
    name, kind, tenant_id: TENANT, user_id: USER, envelope_id: uuid(900 + envelopeN),
    plaintext_json: bytes.toString('utf8'), plaintext_sha256: createHash('sha256').update(bytes).digest('hex'),
    expected_item_fields: union(parsed.decisions), expected_judgement_fields: union(parsed.decisions.flatMap((d) => d.judgements)),
    expected_top_level_fields: Object.keys(parsed).sort(),
  };
}

export function buildFixtures(): Fixture[] {
  const minimal = payload(row(1, { sourceUrl: null, platform: 'cli', decidedAt: null }));
  const rich = payload(row(2), [
    jr('j1', { decision_id: uuid(2), kind: 'note', note: 'Because it ships with node.', via: 'mcp', agent_id: 'claude-code', judged_at: '2026-09-04T10:00:00.000Z' }),
    // Counterparts that are not on the team graph stay local: they show up under left_local, not in the judgements.
    jr('j2', { decision_id: uuid(2), counterpart_id: uuid(7), kind: 'conflict_verdict', value: 'real', judged_at: '2026-09-04T10:01:00.000Z' }),
    jr('j3', { decision_id: uuid(2), counterpart_id: uuid(8), kind: 'supersede', value: null, judged_at: '2026-09-04T10:02:00.000Z' }),
  ]);
  // What `send` re-posts for a matched share that waits on the team's text: only the waiting judgement, carrying the hash.
  const matched = payload(row(3));
  const waiting = matched.shown.filter((s) => s.wire.kind === 'ratify');
  const again: SharePayload = { ...matched, shown: waiting, item: { ...matched.item, judgements: waiting.map((s) => ({ ...s.wire, confirm_team_text_hash: 'team-text-hash-1' })) } };
  const ten = Array.from({ length: 10 }, (_, i) => payload(row(20 + i)));
  return [
    fixture('minimal-share', 'share', 1, [minimal]),
    fixture('rich-share', 'share', 2, [rich]),
    fixture('confirm-team-text', 'confirm_team_text', 3, [again], { remoteId: uuid(500), teamTextHash: 'team-text-hash-1' }),
    fixture('ten-item-share', 'share', 4, ten),
  ];
}

export const serializeFixtures = (fx: Fixture[]): string => `${JSON.stringify(fx, null, 2)}\n`;
