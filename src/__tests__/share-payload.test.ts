import { describe, expect, it } from 'vitest';
import type { DecisionRow } from '../lib/local-db.js';
import type { JudgementRow } from '../lib/curation/judgements-db.js';
import { buildSharePayload, clientKeyFor, hashItem, MAX_SHARED_JUDGEMENTS, shareSourceUrl } from '../lib/share/payload.js';
import { renderPreview } from '../lib/share/preview.js';
import { scanForSecrets, secretsIn } from '../lib/share/secret-scan.js';

/**
 * L9 Test List, the payload / secret scan / preview (pure):
 * - A ratified item with one `false` conflict verdict and one note carries THREE judgements (ratify from the column, the verdict
 *   mapped false -> false_positive, the note), each with kind/value/origin/judged_at, and no judge id, label or context key anywhere.
 * - A check verdict goes as kind, value, time only: its context key and the files behind it appear nowhere in the item or the preview.
 * - A tombstone (value NULL) is not sent. A conflict verdict whose counterpart is not shared is left out and the preview says it stays local;
 *   with the counterpart on the team graph it goes with the counterpart's remote id (either end of the pair).
 * - A supersede travels with the NEWER decision only.
 * - A relayed (mcp) row goes as local_share_mcp with the registry id as agent; 'unknown' omits the agent; a cli row has no agent.
 *   The preview lists mcp rows under "Recorded by your agent (<id>)", and has no such heading when there are none.
 * - The preview and the sent item are one object; the hash moves when a judgement is added and not when it is not.
 * - More than 50 judgements: the ratification and the newest 49 go, the rest are named as staying local.
 * - client_key: a UUID local id is used as is, any other id maps to a stable UUID.
 * - Secret scan: a token of each family is found by NAME (never echoed), clean text is clean, a bare AWS-shaped string counts only near "aws".
 */
const row = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  id: '11111111-1111-4111-8111-111111111111', title: 'Use sqlite for the cache', summary: 'Settled on sqlite because it ships with node.',
  sourceUrl: 'https://github.com/o/r/pull/12', platform: 'github', createdAt: '2026-09-01T00:00:00.000Z', decidedAt: '2026-09-02T09:00:00.000Z',
  repo: null, deciderKind: 'human', confirmedBy: null, confirmedAt: null, ratifiedBy: 'tom@align.tech', ratifiedAt: '2026-09-03T10:00:00.000Z', ...over,
});
let n = 0;
const j = (over: Partial<JudgementRow>): JudgementRow => ({
  id: `j${++n}`, decision_id: row().id, counterpart_id: null, context_key: null, kind: 'note', value: null, note: null,
  judge_id: 'inst-1', judge_label: 'tom@align.tech', via: 'cli', agent_id: null, judged_at: `2026-09-04T10:00:${String(n % 60).padStart(2, '0')}.000Z`, ...over,
});
const build = (judgements: JudgementRow[], remote: Record<string, string> = {}, r = row()) =>
  buildSharePayload({ row: r, judgements, remoteIdOf: (id) => remote[id], titleOf: (id) => `title of ${id}` });
const OTHER = '22222222-2222-4222-8222-222222222222';
const REMOTE = '33333333-3333-4333-8333-333333333333';

describe('what a share carries', () => {
  it('a ratified item with one false conflict verdict and one note is three judgements, and no identity', () => {
    const p = build([
      j({ kind: 'conflict_verdict', counterpart_id: OTHER, value: 'false' }),
      j({ kind: 'note', note: 'checked with the team' }),
    ], { [OTHER]: REMOTE });
    expect(p.item.judgements.map((x) => x.kind)).toEqual(['ratify', 'conflict_verdict', 'note']);
    expect(p.item.judgements[0]).toEqual({ kind: 'ratify', judged_at: '2026-09-03T10:00:00.000Z', origin: 'local_share' });
    expect(p.item.judgements[1]).toMatchObject({ kind: 'conflict_verdict', value: 'false_positive', counterpart_id: REMOTE, origin: 'local_share' });
    expect(p.item.judgements[2]).toMatchObject({ kind: 'note', note: 'checked with the team' });
    for (const w of p.item.judgements) expect(w.judged_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const wire = JSON.stringify(p.item);
    expect(wire).not.toContain('inst-1');
    expect(wire).not.toContain('tom@align.tech');
    expect(wire).not.toMatch(/judge_(id|label)/);
  });
  it('maps real to true_positive', () => {
    const p = build([j({ kind: 'conflict_verdict', counterpart_id: OTHER, value: 'real' })], { [OTHER]: REMOTE });
    expect(p.item.judgements[1]!.value).toBe('true_positive');
  });
  it('sends a check verdict as kind, value and time only, never its context key', () => {
    const p = build([j({ kind: 'check_verdict', context_key: 'sha-of-files-src/secret/path.ts', value: 'false' })]);
    expect(p.item.judgements[1]).toEqual({ kind: 'check_verdict', value: 'false_positive', judged_at: expect.any(String), origin: 'local_share' });
    const shown = JSON.stringify(p.item) + renderPreview([p], { workspace: 'W', env: 'prod', email: 'a@b.c' });
    expect(shown).not.toContain('sha-of-files');
    expect(shown).not.toContain('secret/path');
  });
  it('adds nothing extra for an item with no check verdict', () => {
    expect(build([]).item.judgements.map((x) => x.kind)).toEqual(['ratify']);
  });
  it('does not send a tombstone', () => {
    const p = build([j({ kind: 'conflict_verdict', counterpart_id: OTHER, value: null, note: 'undone' }), j({ kind: 'check_verdict', context_key: 'k', value: null, note: 'undone' })], { [OTHER]: REMOTE });
    expect(p.item.judgements.map((x) => x.kind)).toEqual(['ratify']);
  });
});

describe('pair judgements need the other decision on the team graph', () => {
  it('leaves a verdict out when the counterpart is not shared, says so, and remembers it as deferred', () => {
    const p = build([j({ kind: 'conflict_verdict', counterpart_id: OTHER, value: 'false' })]);
    expect(p.item.judgements.map((x) => x.kind)).toEqual(['ratify']);
    expect(p.leftLocal).toEqual([{ kind: 'conflict_verdict', why: 'counterpart_not_shared', counterpartTitle: `title of ${OTHER}` }]);
    expect(p.deferredPairs).toHaveLength(1);
    expect(renderPreview([p], { workspace: 'W', env: 'prod', email: 'a@b.c' })).toMatch(/Stays on this machine:\s+- a conflict verdict about "title of 2222.*not on your team graph/);
  });
  it('sends it with the remote id of the counterpart when the pair is the other way round too', () => {
    const p = build([j({ decision_id: OTHER, counterpart_id: row().id, kind: 'conflict_verdict', value: 'real' })], { [OTHER]: REMOTE });
    expect(p.item.judgements[1]).toMatchObject({ kind: 'conflict_verdict', counterpart_id: REMOTE, value: 'true_positive' });
  });
  it('sends a supersede with the newer decision, and not with the older one', () => {
    const sup = j({ kind: 'supersede', decision_id: row().id, counterpart_id: OTHER });
    expect(build([sup], { [OTHER]: REMOTE }).item.judgements.map((x) => x.kind)).toEqual(['ratify', 'supersede']);
    const asOlder = j({ kind: 'supersede', decision_id: OTHER, counterpart_id: row().id });
    const p = build([asOlder], { [OTHER]: REMOTE });
    expect(p.item.judgements.map((x) => x.kind)).toEqual(['ratify']);
    expect(p.leftLocal).toEqual([]);
  });
});

describe('judgements an agent relayed', () => {
  const mcp = j({ kind: 'note', note: 'relayed', via: 'mcp', agent_id: 'claude-code' });
  it('go as local_share_mcp with the registry id, and are listed under their own heading', () => {
    const p = build([mcp, j({ kind: 'note', note: 'mine' })]);
    expect(p.item.judgements.find((x) => x.note === 'relayed')).toMatchObject({ origin: 'local_share_mcp', agent: 'claude-code' });
    const mine = p.item.judgements.find((x) => x.note === 'mine')!;
    expect(mine.origin).toBe('local_share');
    expect('agent' in mine).toBe(false);
    const text = renderPreview([p], { workspace: 'W', env: 'prod', email: 'a@b.c' });
    expect(text).toMatch(/Recorded by your agent \(claude-code\):\s+- note: "relayed"/);
    expect(text).toMatch(/Goes with it:[\s\S]*note: "mine"/);
  });
  it('omits an agent id of unknown, and shows no agent heading when every row is the person\'s own', () => {
    const p = build([j({ kind: 'note', note: 'x', via: 'mcp', agent_id: 'unknown' })]);
    const w = p.item.judgements.find((x) => x.note === 'x')!;
    expect(w.origin).toBe('local_share_mcp');
    expect('agent' in w).toBe(false);
    expect(renderPreview([build([j({ kind: 'note', note: 'y' })])], { workspace: 'W', env: 'prod', email: 'a@b.c' })).not.toContain('Recorded by your agent');
  });
});

describe('the item and its hash', () => {
  it('shows the title, text, source and destination, and the hash moves with a new judgement only', () => {
    const a = build([]);
    const b = build([]);
    const c = build([j({ kind: 'note', note: 'new' })]);
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(a.hash).toBe(hashItem(a.item));
    const text = renderPreview([a], { workspace: 'Acme', env: 'prod', email: 'me@co.com' }, { updates: new Set([a.localId]) });
    expect(text).toContain('To: Acme (prod) as me@co.com');
    expect(text).toContain('Use sqlite for the cache');
    expect(text).toContain('Settled on sqlite because it ships with node.');
    expect(text).toContain('Source: https://github.com/o/r/pull/12 (github)');
    expect(text).toContain('(update: you shared this before)');
    expect(text).toContain('Nothing is sent until you say yes.');
  });
  it('sends the text as raw_text and the decided date as created_at, and a stable source for a row with none', () => {
    const p = build([], {}, row({ sourceUrl: null, decidedAt: null }));
    expect(p.item.source_url).toBe(`align-local://decision/${row().id}`);
    expect('created_at' in p.item).toBe(false);
    expect(shareSourceUrl({ id: 'x', sourceUrl: 'https://a/b' })).toBe('https://a/b');
  });
  it('flags a legacy push in the preview', () => {
    const p = build([]);
    expect(renderPreview([p], { workspace: 'W', env: 'prod', email: 'a@b.c' }, { legacy: new Set([p.localId]) })).toContain('may create a second copy');
  });
});

describe('the cap', () => {
  it('keeps the ratification and the newest judgements, and names the rest as staying local', () => {
    const notes = Array.from({ length: 60 }, (_, i) => j({ kind: 'note', note: `n${i}`, judged_at: `2026-09-04T11:${String(i).padStart(2, '0')}:00.000Z` }));
    const p = build(notes);
    expect(p.item.judgements).toHaveLength(MAX_SHARED_JUDGEMENTS);
    expect(p.item.judgements[0]!.kind).toBe('ratify');
    expect(p.item.judgements.at(-1)!.note).toBe('n59');
    expect(p.item.judgements.some((x) => x.note === 'n0')).toBe(false);
    expect(p.leftLocal.filter((l) => l.why === 'over_limit')).toHaveLength(11);
  });
});

describe('client_key', () => {
  it('uses a UUID local id as it is and maps any other id to the same UUID every time', () => {
    expect(clientKeyFor('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const k = clientKeyFor('legacy-id-7');
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(clientKeyFor('legacy-id-7')).toBe(k);
    expect(clientKeyFor('legacy-id-8')).not.toBe(k);
  });
});

describe('the secret scan', () => {
  const TOKENS: Array<[string, string]> = [
    ['<GITHUB_TOKEN>', 'ghp_' + 'x'.repeat(36)],
    ['<AWS_ACCESS_KEY>', 'AKIA' + 'B'.repeat(16)],
    ['<ANTHROPIC_KEY>', 'sk-ant-' + 'a'.repeat(96)],
    ['<SLACK_TOKEN>', 'xoxb-' + '1'.repeat(11) + '-' + '2'.repeat(11) + '-' + 'z'.repeat(24)],
    ['<URL_CREDENTIALS>', 'https://user:hunter2@example.com/x'],
  ];
  it.each(TOKENS)('finds %s by name', (placeholder, token) => {
    expect(secretsIn(`the key is ${token} ok`)).toContain(placeholder);
  });
  it('names the field and the placeholder, and never returns the match', () => {
    const found = scanForSecrets([{ field: 'summary', text: 'key ' + 'ghp_' + 'x'.repeat(36) }, { field: 'title', text: 'Use sqlite' }]);
    expect(found).toEqual([{ field: 'summary', placeholder: '<GITHUB_TOKEN>' }]);
    expect(JSON.stringify(found)).not.toContain('xxxx');
  });
  it('passes clean text, empty text and a missing field', () => {
    expect(scanForSecrets([{ field: 'summary', text: 'We chose sqlite for the cache' }, { field: 'note', text: '' }, { field: 'x', text: null }])).toEqual([]);
  });
  it('treats a bare 40 character mixed string as an AWS secret only near the word aws', () => {
    const bare = 'aB3'.repeat(13) + 'Z';
    expect(bare).toHaveLength(40);
    expect(secretsIn(`value ${bare}`)).not.toContain('<AWS_SECRET_KEY>');
    expect(secretsIn(`aws account value ${bare}`)).toContain('<AWS_SECRET_KEY>');
  });
});
