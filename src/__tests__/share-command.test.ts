import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { upsertJudgement } from '../lib/curation/judgements-db.js';
import { runShare, type ShareDeps, type ShareOptions } from '../lib/share/command.js';
import { getPromotion } from '../lib/share/ledger.js';
import { issueCode } from '../lib/share/pending.js';
import { prepare } from '../lib/share/run.js';
import type { BatchResponse } from '../lib/share/wire.js';
import { BOOK_CALL_URL, teamCtaLine } from '../lib/team-cta.js';

/**
 * L9 Test List, `align share`:
 * - no team login: the CTA and exit 1, no call at all. Unratified / unknown id: refusal, no send.
 * - exact preview + "To: <workspace> (<env>) as <email>" before a default-No question; No sends nothing; Yes sends once, and the
 *   previewed JSON is the sent item. No interactive terminal: exit 1, nothing sent. There is no --yes.
 * - a credential in the text: exit 1 naming the placeholder and field, the match never printed, nothing sent.
 * - ledger: a created share is recorded (remote id, tenant, hash); an unchanged re-share says "Already shared" and calls nothing;
 *   a new note is an update with the same client_key.
 * - matched share: ratify waits for the team's text; the text is shown; yes re-sends with confirm_team_text_hash on ratify only; no does not.
 * - refused / ambiguous / unknown outcomes: reported by name, refused and unknown exit 1 and write no ledger row.
 * - retract: archives the remote id and stamps the ledger; another workspace's row, a matched row and no row call nothing.
 * - --confirm: valid code + tty yes sends; no controlling tty, expired, used, changed payload, other env: exit 1 and nothing sent.
 * - --all-ratified shares only what the person ratified; no selector at all is a usage error.
 */
let dir: string; let dbPath: string; let stateDir: string;
const ME = 'me@co.com';
const TENANT = { id: 'T1', name: 'Acme' };
const ID1 = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-'));
  dbPath = path.join(dir, 'graph.db');
  stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  vi.stubEnv('XDG_STATE_HOME', stateDir);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

function seed(over: { id?: string; ratify?: string | null; summary?: string; title?: string } = {}): string {
  const db = createLocalDb(dbPath);
  const id = db.insertDecision({ title: over.title ?? 'Use sqlite for the cache', summary: over.summary ?? 'sqlite ships with node', sourceUrl: 'https://github.com/o/r/pull/12', platform: 'github', decidedAt: '2026-09-02T09:00:00.000Z' });
  if (over.ratify !== null) db.markRatified(id, over.ratify ?? ME);
  db.close();
  return id;
}
const judge = { judgeId: 'inst-1', judgeLabel: ME };
const note = (id: string, text: string) => upsertJudgement(dbPath, { kind: 'note', decisionId: id, note: text }, judge, { via: 'cli' });

interface Fx { out: string[]; err: string[]; sent: Array<Array<Record<string, unknown>>>; archived: string[]; asks: string[]; deps: ShareDeps; reply: { current: BatchResponse | ((i: Array<Record<string, unknown>>, n: number) => BatchResponse) }; tty: { answer: boolean | null; queue: Array<boolean | null> }; shown: string[]; whoamiCalls: { n: number }; team: Record<string, unknown> }
function fixture(): Fx {
  const f = { out: [] as string[], err: [] as string[], sent: [] as Array<Array<Record<string, unknown>>>, archived: [] as string[], asks: [] as string[], shown: [] as string[], whoamiCalls: { n: 0 },
    reply: { current: ((items: Array<Record<string, unknown>>) => ({ snapshots: items.map((_, i) => ({ id: `R${i}`, request_index: i, is_new: true })), judgements: items.map((it, i) => ({ request_index: i, decision_id: `R${i}`, results: (it['judgements'] as unknown[]).map(() => ({ ok: true, stored: true })) })) })) as Fx['reply']['current'] },
    tty: { answer: true as boolean | null, queue: [] as Array<boolean | null> }, team: { title: 'Team title', summary: 'Team summary', decision_json: { ai: { decisions: ['Team statement'], gherkin: 'Given team gherkin', acceptance_criteria: 'Team criteria' } } } as Record<string, unknown> };
  const deps: ShareDeps = {
    cloudEnv: { mode: 'auth', gatewayUrl: 'https://x', authToken: 't', tenantId: 'T1' }, localDbPath: dbPath, salt: 'salt-1', defaultGatewayUrl: 'https://x',
    client: () => ({
      whoami: async () => { f.whoamiCalls.n++; return { user: { email: ME }, tenant: TENANT }; },
      shareBatch: async (items) => { f.sent.push(items); const r = f.reply.current; return typeof r === 'function' ? r(items, f.sent.length) : r; },
      getDecision: async () => f.team,
      archiveDecision: async (id) => { f.archived.push(id); },
    }),
    judge: async () => judge, owner: async () => ME,
    ttyConfirm: async (shown, q) => { f.asks.push(q); f.shown.push(shown); return f.tty.queue.length ? f.tty.queue.shift()! : f.tty.answer; },
    out: (l) => f.out.push(l), err: (l) => f.err.push(l),
  };
  return Object.assign(f, { deps }) as unknown as Fx;
}
const run = (f: Fx, o: Partial<ShareOptions> = {}) => runShare({ ids: [], envName: 'prod', ...o }, f.deps);
const text = (f: Fx) => [...f.out, ...f.err, ...f.shown].join('\n');

describe('what refuses before anything is previewed', () => {
  it('no team login: the CTA, exit 1, and no call', async () => {
    const f = fixture(); const id = seed();
    f.deps.cloudEnv = { mode: 'auth', gatewayUrl: 'https://x', authToken: null, tenantId: null };
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(text(f)).toContain(teamCtaLine());
    expect(text(f)).toContain(BOOK_CALL_URL);
    expect(f.whoamiCalls.n).toBe(0); expect(f.sent).toHaveLength(0);
  });
  it('a local-embedded destination is the same refusal', async () => {
    const f = fixture(); const id = seed();
    f.deps.cloudEnv = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null };
    expect(await run(f, { ids: [id] })).toBe(1); expect(f.sent).toHaveLength(0);
  });
  it('an unratified row names align ratify; an unknown id names the id; neither sends', async () => {
    const f = fixture(); const id = seed({ ratify: null });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(text(f)).toContain(`align ratify ${id}`);
    const g = fixture();
    expect(await run(g, { ids: ['nope'] })).toBe(1);
    expect(text(g)).toContain('nope');
    expect(f.sent.length + g.sent.length).toBe(0);
  });
});

describe('preview, confirmation and the send', () => {
  it('previews text and destination, and sends nothing on No', async () => {
    const f = fixture(); const id = seed(); f.tty.answer = false;
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(text(f)).toContain('To: Acme (prod) as me@co.com');
    expect(text(f)).toContain('Use sqlite for the cache');
    expect(f.asks).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toBeNull();
  });
  it('sends once on Yes, the sent item is the previewed one, and the ledger remembers it', async () => {
    const f = fixture(); const id = seed(); note(id, 'checked with the team');
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.sent).toHaveLength(1);
    const item = f.sent[0]![0]!;
    expect(item).toMatchObject({ title: 'Use sqlite for the cache', raw_text: 'sqlite ships with node', platform: 'github', client_key: ID1.length === 36 ? item['client_key'] : '' });
    expect((item['judgements'] as Array<{ kind: string }>).map((j) => j.kind)).toEqual(['ratify', 'note']);
    expect(text(f)).toContain('checked with the team'); // the preview showed the judgement it sent
    expect(text(f)).toContain('created: R0');
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ remoteId: 'R0', matched: false });
  });
  it('with no interactive terminal (an agent shell, a pipe): exit 1, nothing sent, and the preview is not dumped to stdout', async () => {
    const f = fixture(); const id = seed(); f.tty.answer = null;
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(f.err.join('\n')).toContain('Confirm this in your own terminal');
    expect(f.sent).toHaveLength(0);
  });
  it('refuses a credential by placeholder and field, never printing it, and sends nothing', async () => {
    const f = fixture(); const id = seed({ summary: `key ${`ghp_${  'x'.repeat(36)}`}` });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(text(f)).toContain('<GITHUB_TOKEN>'); expect(text(f)).toContain('summary');
    expect(text(f)).not.toContain('xxxxxxxx');
    expect(f.sent).toHaveLength(0);
  });
  it('a credential in a note is refused too (clean text goes)', async () => {
    const f = fixture(); const id = seed(); note(id, `token ${`ghp_${  'y'.repeat(36)}`}`);
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(f.sent).toHaveLength(0);
  });
});

describe('the ledger and idempotency', () => {
  it('says already shared and calls nothing when nothing changed; a new note is an update with the same client_key', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    const key = f.sent[0]![0]!['client_key'];
    f.out.length = 0;
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(text(f)).toContain('Already shared as R0');
    expect(f.sent).toHaveLength(1);
    note(id, 'new thought');
    f.reply.current = { snapshots: [{ id: 'R0', request_index: 0, is_new: false }] };
    await run(f, { ids: [id] });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]![0]!['client_key']).toBe(key);
    expect(text(f)).toContain('(update: you shared this before)');
    expect(text(f)).toContain('updated: R0');
  });
});

describe('a share that matches a decision the team already holds', () => {
  const matchedReply = (hash: string): BatchResponse => ({
    matched: [{ request_index: 0, existing_id: 'TEAM1', status: 'active', team_text_hash: hash, needs_confirmation: [{ kind: 'ratify', judgement_index: 0 }] }],
    judgements: [{ request_index: 0, decision_id: 'TEAM1', results: [{ ok: false, error: 'needs_confirmation' }, { ok: true, stored: true }] }],
  });
  it('shows the team text and re-sends with the hash on the ratify only when the person agrees', async () => {
    const f = fixture(); const id = seed(); note(id, 'n');
    const h = 'a'.repeat(64);
    f.reply.current = (items, n) => (n === 1 ? matchedReply(h) : { matched: [{ request_index: 0, existing_id: 'TEAM1', status: 'active', team_text_hash: h }], judgements: [{ request_index: 0, decision_id: 'TEAM1', results: [{ ok: true, stored: true }, { ok: true, stored: true }] }] });
    expect(await run(f, { ids: [id] })).toBe(0);
    // every field the server's team-text hash covers is in front of the person
    for (const part of ['Team title', 'Team summary', 'Team statement', 'Given team gherkin', 'Team criteria']) expect(text(f)).toContain(part);
    expect(f.sent).toHaveLength(2);
    // the re-post carries ONLY the ratify that waited: the note was stored the first time and is not posted again
    const second = f.sent[1]![0]!['judgements'] as Array<{ kind: string; confirm_team_text_hash?: string }>;
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ kind: 'ratify', confirm_team_text_hash: h });
    expect((f.sent[0]![0]!['judgements'] as unknown[]).length).toBe(2);
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ remoteId: 'TEAM1', matched: true, confirmPending: false });
  });
  it('does not re-send when the person declines, says the ratify waits, and records the match with the confirmation still pending', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = matchedReply('b'.repeat(64));
    f.tty.queue = [true, false]; // the share, then the team's text
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(text(f)).toContain('waits for you to confirm');
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ matched: true, confirmPending: true });
    // not "already shared": the ratify is offered again
    const g = fixture(); g.reply.current = matchedReply('b'.repeat(64));
    f.out.length = 0; f.tty.queue = [false];
    await run(f, { ids: [id] });
    expect(f.out.join('\n')).not.toContain('Already shared');
  });
  it('never confirms when the gateway cannot show the full team text', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = matchedReply('d'.repeat(64));
    f.team = { title: 'T', summary: 'S' }; // no decision_json: the AI fields the hash covers cannot be read
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(f.asks.some((q) => /stand behind/.test(q))).toBe(false);
    expect(text(f)).toContain('could not be read');
  });
  it('a person who declines the team text leaves the ratify unconfirmed even though the share went', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = matchedReply('c'.repeat(64));
    f.tty.queue = [true, false];
    await run(f, { ids: [id] });
    expect(f.sent).toHaveLength(1);
  });
});

describe('outcomes the server can answer with', () => {
  it('refused exits 1 and records nothing; ambiguous is said; an unmentioned item is unknown and exits 1', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = { refused: [{ request_index: 0, reason: 'source_not_visible' }] };
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(text(f)).toContain('refused by the server (source_not_visible)');
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toBeNull();
    f.reply.current = {};
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(text(f)).toContain('did not say what happened');
    f.reply.current = { snapshots: [{ id: 'N', request_index: 0 }], match_ambiguous: [0] };
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(text(f)).toContain('several team decisions share this source');
  });
  it('reports a judgement the server did not store', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = { snapshots: [{ id: 'N', request_index: 0 }], judgements: [{ request_index: 0, decision_id: 'N', results: [{ ok: false, error: 'ratification_not_permitted' }] }] };
    await run(f, { ids: [id] });
    expect(text(f)).toContain('your role may not ratify here');
  });
});

describe('retract', () => {
  it('archives the remote id and stamps the ledger', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    expect(await run(f, { retract: id })).toBe(0);
    expect(f.archived).toEqual(['R0']);
    expect(getPromotion(dbPath, id, 'prod', 'T1')!.retractedAt).not.toBeNull();
    f.archived.length = 0;
    expect(await run(f, { retract: id })).toBe(1); // a second retract finds nothing live
    expect(f.archived).toEqual([]);
  });
  it('calls nothing for another workspace, for a matched row, or for no row', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    const other = fixture(); other.deps.client = () => ({ whoami: async () => ({ user: { email: ME }, tenant: { id: 'T2', name: 'Other' } }), shareBatch: async () => ({}), getDecision: async () => ({}), archiveDecision: async (x) => { other.archived.push(x); } });
    expect(await run(other, { retract: id })).toBe(1);
    expect(other.archived).toEqual([]);
    const m = fixture(); const id2 = seed({ title: 'second' });
    m.reply.current = { matched: [{ request_index: 0, existing_id: 'TEAM9', status: 'active' }] };
    await run(m, { ids: [id2] });
    expect(getPromotion(dbPath, id2, 'prod', 'T1')!.matched).toBe(true);
    expect(await run(m, { retract: id2 })).toBe(1);
    expect(text(m)).toContain('THEIR decision');
    expect(m.archived).toEqual([]);
    expect(await run(m, { retract: 'never-shared' })).toBe(1);
  });
});

describe('--confirm <code>', () => {
  async function codeFor(f: Fx, id: string, envName = 'prod'): Promise<string> {
    const prep = await prepare({ dbPath, envName, client: f.deps.client(), judge, salt: 'salt-1', gatewayUrl: 'https://x', defaultGatewayUrl: 'https://x' }, [id]);
    return issueCode(prep.payloads, { agentId: 'claude-code', envName, preview: prep.preview, to: { tenantId: prep.tenantId, gatewayUrl: prep.gatewayUrl } })!;
  }
  it('sends once for a valid code with a tty yes, and the code is then spent', async () => {
    const f = fixture(); const id = seed(); const code = await codeFor(f, id);
    expect(await run(f, { confirm: code })).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(f.asks[0]).toMatch(/^Share 1 decision/);
    expect(await run(f, { confirm: code })).toBe(1); // spent
    expect(f.sent).toHaveLength(1);
  });
  it('without a controlling terminal: exit 1, "Confirm this in your own terminal", nothing sent, code still valid', async () => {
    const f = fixture(); const id = seed(); const code = await codeFor(f, id); f.tty.answer = null;
    expect(await run(f, { confirm: code })).toBe(1);
    expect(text(f)).toContain('Confirm this in your own terminal');
    expect(f.sent).toHaveLength(0);
    f.tty.answer = true;
    expect(await run(f, { confirm: code })).toBe(0);
  });
  it('a No at the terminal sends nothing', async () => {
    const f = fixture(); const id = seed(); const code = await codeFor(f, id); f.tty.answer = false;
    expect(await run(f, { confirm: code })).toBe(0);
    expect(f.sent).toHaveLength(0);
  });
  it('refuses a malformed, unknown or expired code, and a payload that changed since it was issued', async () => {
    const f = fixture(); const id = seed();
    expect(await run(f, { confirm: '../../etc/passwd' })).toBe(1);
    expect(await run(f, { confirm: 'abcdefghij' })).toBe(1);
    const code = await codeFor(f, id);
    note(id, 'added after the preview');
    expect(await run(f, { confirm: code })).toBe(1);
    expect(text(f)).toContain('has changed since your agent previewed it');
    const fresh = await codeFor(f, id);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    try { expect(await run(f, { confirm: fresh })).toBe(1); } finally { vi.useRealTimers(); }
    expect(text(f)).toContain('expired');
    expect(f.sent).toHaveLength(0);
  });
  it('a code for another environment is refused', async () => {
    const f = fixture(); const id = seed(); const code = await codeFor(f, id, 'preview');
    expect(await run(f, { confirm: code })).toBe(1);
    expect(f.sent).toHaveLength(0);
  });
});

describe('choosing what to share', () => {
  it('--all-ratified shares only what this person ratified', async () => {
    const f = fixture(); const mine = seed({ title: 'mine' }); seed({ title: 'theirs', ratify: 'other@co.com' }); seed({ title: 'unratified', ratify: null });
    expect(await run(f, { allRatified: true })).toBe(0);
    expect(f.sent[0]!.map((i) => i['title'])).toEqual(['mine']);
    expect(mine).toBeTruthy();
  });
  it('--since keeps only decisions ratified in the window', async () => {
    const f = fixture(); seed({ title: 'now' });
    expect(await run(f, { sinceIso: new Date(Date.now() + 86_400_000).toISOString() })).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect(await run(f, { sinceIso: new Date(Date.now() - 86_400_000).toISOString() })).toBe(0);
    expect(f.sent).toHaveLength(1);
  });
  it('naming nothing is a usage error', async () => {
    const f = fixture(); seed();
    expect(await run(f, {})).toBe(2);
    expect(f.sent).toHaveLength(0);
  });
});

/**
 * L9 security review, items 3, 4, 5, 7, 8, 10 (client side):
 * - a re-share sends ONLY judgements the workspace has not stored; a text-only edit sends none; a judgement the gateway did not store is offered again.
 * - a gateway that reports no judgements: warned ("your ratify was not stored by this gateway"), nothing recorded as stored.
 * - a first share the gateway answers as an existing row (no matching): recorded as matched, warned, and never retractable.
 * - the client_key is minted once (opaque, not the local id) and reused even if the install salt changes.
 * - the gateway host is shown whenever it is not the environment's default; a code is refused when the workspace (Acme -> Other Corp) or the gateway changed.
 * - the summary is sent explicitly; platform, a secret-named URL parameter and a note's index among NOTES are scanned and named.
 */
describe('a re-share sends only what is new', () => {
  const judgementsOf = (f: Fx, n: number) => (f.sent[n]![0]!['judgements'] as Array<{ kind: string; note?: string }>).map((j) => j.note ?? j.kind);
  it('posts the new note and not the ratify or the old note again', async () => {
    const f = fixture(); const id = seed(); note(id, 'first');
    await run(f, { ids: [id] });
    note(id, 'second');
    f.reply.current = (items) => ({ snapshots: [{ id: 'R0', request_index: 0, is_new: false }], judgements: [{ request_index: 0, decision_id: 'R0', results: (items[0]!['judgements'] as unknown[]).map(() => ({ ok: true, stored: true })) }] });
    await run(f, { ids: [id] });
    expect(judgementsOf(f, 0)).toEqual(['ratify', 'first']);
    expect(judgementsOf(f, 1)).toEqual(['second']);
    expect(f.shown[1]).toContain('note: "second"');
    expect(f.shown[1]).not.toContain('note: "first"'); // the second preview lists only what it will send
    f.out.length = 0; f.shown.length = 0;
    await run(f, { ids: [id] });
    expect(text(f)).toContain('Already shared');
    expect(f.sent).toHaveLength(2);
  });
  it('a text-only edit is an update with no judgements', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(dbPath); d.prepare('UPDATE decisions SET summary = ? WHERE id = ?').run('reworded', id); d.close();
    f.reply.current = { snapshots: [{ id: 'R0', request_index: 0, is_new: false }] };
    await run(f, { ids: [id] });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]![0]!['judgements']).toEqual([]);
    expect(f.sent[1]![0]!['summary']).toBe('reworded');
  });
  it('a judgement the gateway did not store is offered again on the next share', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = { snapshots: [{ id: 'R0', request_index: 0 }], judgements: [{ request_index: 0, decision_id: 'R0', results: [{ ok: false, error: 'ratification_not_permitted' }] }] };
    await run(f, { ids: [id] });
    f.reply.current = { snapshots: [{ id: 'R0', request_index: 0, is_new: false }], judgements: [{ request_index: 0, decision_id: 'R0', results: [{ ok: true, stored: true }] }] };
    await run(f, { ids: [id] });
    expect(f.sent).toHaveLength(2);
    expect(judgementsOf(f, 1)).toEqual(['ratify']);
  });
});

describe('what an older gateway can hide', () => {
  it('says so when no judgement report comes back, and does not count them as stored', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = { snapshots: [{ id: 'R0', request_index: 0, is_new: true }] };
    await run(f, { ids: [id] });
    expect(text(f)).toContain('your ratify was not stored by this gateway');
    expect(getPromotion(dbPath, id, 'prod', 'T1')!.sent).toEqual([]);
  });
  it('a FIRST share answered as an existing row is recorded as matched, warned, and refused by retract', async () => {
    const f = fixture(); const id = seed();
    f.reply.current = { snapshots: [{ id: 'THEIRS', request_index: 0, is_new: false }] };
    await run(f, { ids: [id] });
    expect(text(f)).toContain('not yours to retract');
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ remoteId: 'THEIRS', matched: true });
    expect(await run(f, { retract: id })).toBe(1);
    expect(f.archived).toEqual([]);
  });
});

describe('the client_key', () => {
  it('is opaque, minted once, and reused even when the install salt changes', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    const key = f.sent[0]![0]!['client_key'];
    expect(key).not.toBe(id);
    expect(JSON.stringify(f.sent[0])).not.toContain(id);
    f.deps.salt = 'a-different-salt';
    note(id, 'later');
    f.reply.current = { snapshots: [{ id: 'R0', request_index: 0, is_new: false }] };
    await run(f, { ids: [id] });
    expect(f.sent[1]![0]!['client_key']).toBe(key);
    expect(getPromotion(dbPath, id, 'prod', 'T1')!.clientKey).toBe(key);
  });
});

describe('where it goes', () => {
  it('names the gateway when it is not the default for the environment, and not otherwise', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    expect(f.shown.join('\n')).not.toContain('via ');
    const g = fixture(); const id2 = seed({ title: 'two' });
    g.deps.defaultGatewayUrl = 'https://api.align.tech';
    await run(g, { ids: [id2] });
    expect(g.shown.join('\n')).toContain('via https://x (not the default for prod)');
  });
  it('refuses a code when the workspace changed (Acme -> Other Corp) or the gateway changed, and sends nothing', async () => {
    const f = fixture(); const id = seed();
    const prep = await prepare({ dbPath, envName: 'prod', client: f.deps.client(), judge, salt: 'salt-1', gatewayUrl: 'https://x', defaultGatewayUrl: 'https://x' }, [id]);
    const code = issueCode(prep.payloads, { agentId: 'codex', envName: 'prod', preview: prep.preview, to: { tenantId: prep.tenantId, gatewayUrl: prep.gatewayUrl } })!;
    const base = f.deps.client();
    f.deps.client = () => ({ ...base, whoami: async () => ({ user: { email: ME }, tenant: { id: 'T2', name: 'Other Corp' } }) });
    expect(await run(f, { confirm: code })).toBe(1);
    expect(text(f)).toContain('workspace or the gateway');
    f.deps.client = () => base;
    f.deps.cloudEnv = { ...f.deps.cloudEnv, gatewayUrl: 'https://evil.example' };
    expect(await run(f, { confirm: code })).toBe(1);
    expect(f.sent).toHaveLength(0);
    f.deps.cloudEnv = { ...f.deps.cloudEnv, gatewayUrl: 'https://x' };
    expect(await run(f, { confirm: code })).toBe(0); // the control: the same code works against the destination it was issued for
    expect(f.sent).toHaveLength(1);
  });
  it('refuses demo mode up front', async () => {
    const f = fixture(); const id = seed();
    f.deps.cloudEnv = { mode: 'demo', gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null };
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(f.whoamiCalls.n).toBe(0);
  });
});

describe('what is scanned', () => {
  it('scans the platform, a secret-named URL parameter (by name, never value) and numbers notes among notes', async () => {
    const f = fixture();
    const db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 'z', summary: 's', sourceUrl: 'https://zoom.us/rec/share/x?pwd=hunter2hunter2', platform: `ghp_${'q'.repeat(36)}` });
    db.markRatified(id, ME); db.close();
    note(id, 'clean note'); note(id, `leak ${`ghp_${  'z'.repeat(36)}`}`);
    expect(await run(f, { ids: [id] })).toBe(1);
    const t = text(f);
    expect(t).toContain('platform looks like <GITHUB_TOKEN>');
    expect(t).toContain('source_url (parameter pwd)');
    expect(t).toContain('note 2 looks like <GITHUB_TOKEN>'); // the ratify is judgement 1 and the clean note is note 1
    expect(t).not.toContain('hunter2');
    expect(f.sent).toHaveLength(0);
  });
});
