import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { POLL_MAX_MS, POLL_START_MS } from '../lib/share/approval.js';
import { groupForApproval } from '../lib/share/browser-flow.js';
import { runShare, type ShareDeps, type ShareOptions } from '../lib/share/command.js';
import { getPromotion } from '../lib/share/ledger.js';
import type { SharePayload } from '../lib/share/payload.js';
import { buildPlaintext, MAX_PLAINTEXT_BYTES } from '../lib/share/envelope.js';
import { SHARE_BATCH_ITEMS, ShareError } from '../lib/share/run.js';
import type { BatchResponse } from '../lib/share/wire.js';
import { fakeRequests, type FakeRequests, keyOf, openInBrowserWay, urlIn } from './helpers/share-requests-fake.js';

/**
 * ALI-1540 Test List, `align share` with browser approval (the gateway is a fake; its route shapes are the contract):
 * - available: stage, print link and code, poll (pending, pending, approved), complete, print results. It never prompts
 *   on the terminal and never calls shareBatch. Two decisions, one request.
 * - the key: opens the envelope in WebCrypto; is never sent in any request; is in the link's FRAGMENT only and printed once.
 * - declined: "Nothing was sent", exit 0. Expired: restart hint, exit 1. An approval in the last second is not lost to a fast clock.
 * - Ctrl-C: the request is cancelled and the process says so; a cancel that fails says so too. Nothing is sent either way.
 * - polling backs off from 2 s to a cap, tolerates two failed reads in a row, gives up on the third.
 * - gating: `required` never reaches the typed path (--typed and --confirm refused); `available` + --typed does; `off` and
 *   a missing route are the typed path unchanged; a config that FAILS stops the run and falls back to nothing.
 * - agents: inside ALIGN_WRAPPED the browser path runs (it can ask, not approve) and the typed path is refused.
 * - a matched share waiting on the team's text stages a SECOND request (confirm_team_text) and still never prompts.
 */
let dir: string; let dbPath: string; let clock: number;
const TH = 'a'.repeat(64);
const ME = 'me@co.com';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-appr-'));
  dbPath = path.join(dir, 'graph.db');
  vi.stubEnv('XDG_STATE_HOME', path.join(dir, 'state')); fs.mkdirSync(path.join(dir, 'state'));
  clock = Date.now();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

function seed(title = 'Use sqlite for the cache', n = 1): string {
  const db = createLocalDb(dbPath);
  const id = db.insertDecision({ title, summary: 'sqlite ships with node', sourceUrl: `https://github.com/o/r/pull/${n}`, platform: 'github', decidedAt: '2026-09-02T09:00:00.000Z' });
  db.markRatified(id, ME); db.close();
  return id;
}

interface Fx { out: string[]; err: string[]; gw: FakeRequests; asks: string[]; batches: number; opened: string[]; sleeps: number[]; deps: ShareDeps; abort: AbortController; teamReads: number }
function fixture(init: Parameters<typeof fakeRequests>[0] = {}): Fx {
  const gw = fakeRequests(init);
  const f = { out: [] as string[], err: [] as string[], gw, asks: [] as string[], batches: 0, opened: [] as string[], sleeps: [] as number[], abort: new AbortController(), teamReads: 0 } as Fx;
  f.deps = {
    cloudEnv: { mode: 'auth', gatewayUrl: 'https://api.align.test', authToken: 't', tenantId: 'T1' }, localDbPath: dbPath, salt: 'salt-1', defaultGatewayUrl: 'https://api.align.test',
    client: () => ({
      ...gw.api,
      whoami: async () => ({ user: { email: ME, id: 'U1' }, tenant: { id: 'T1', name: 'Acme' } }),
      shareBatch: async () => { f.batches++; return { snapshots: [{ id: 'TYPED', request_index: 0, is_new: true }] }; },
      getDecision: async () => { f.teamReads++; return { title: 'Team', summary: 'Team text', decision_json: {} }; },
      archiveDecision: async () => undefined,
    }),
    judge: async () => ({ judgeId: 'inst-1', judgeLabel: ME }), owner: async () => ME, wrapped: false,
    ttyConfirm: async (_s, q) => { f.asks.push(q); return true; },
    approval: {
      appUrl: 'https://app.align.test', label: 'tom-laptop',
      openUrl: async (u) => { f.opened.push(u); return true; },
      sleep: async (ms) => { f.sleeps.push(ms); clock += ms; },
      now: () => clock,
      guard: async (run) => run(f.abort.signal),
    },
    out: (l) => f.out.push(l), err: (l) => f.err.push(l),
  };
  return f;
}
const run = (f: Fx, o: Partial<ShareOptions> = {}) => runShare({ ids: [], envName: 'prod', ...o }, f.deps);
const say = (f: Fx) => [...f.out, ...f.err].join('\n');

describe('available: the person approves in a browser', () => {
  it('stages, prints the link and the code, polls until approved, completes once, prints the results, and never prompts or posts directly', async () => {
    const f = fixture({ states: ['pending', 'pending', 'approved'] }); const id = seed();
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.gw.staged).toHaveLength(1);
    expect(f.gw.staged[0]).toMatchObject({ kind: 'share', item_count: 1, requester_label: 'tom-laptop' });
    const envelopeId = f.gw.staged[0]!.envelope_id;
    expect(envelopeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.gw.staged[0]).not.toHaveProperty('id');           // the CLI's id is the envelope id, never the row's primary key
    const rowId = f.gw.rowIds.get(envelopeId)!;
    expect(rowId).not.toBe(envelopeId);                        // every later call uses the SERVER's id
    expect(f.gw.gets).toBe(3);
    expect(f.gw.completes).toHaveLength(1);
    expect(f.gw.completes[0]!.id).toBe(rowId);
    expect(f.asks).toEqual([]);          // never prompted on a terminal
    expect(f.batches).toBe(0);           // never called shareBatch
    expect(say(f)).toContain('To: Acme (prod) as me@co.com');   // the destination, as before
    expect(say(f)).toContain('Code: KJ4M-9XQT');
    expect(say(f)).toMatch(/expires in 1[45] minutes/);
    expect(say(f)).toContain('Approved in your browser. Sending...');
    expect(say(f)).toContain('created: R0');
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ remoteId: 'R0' });
    expect(f.opened).toEqual([urlIn(f.out)]);
  });
  it('sends one request for two decisions', async () => {
    const f = fixture(); const a = seed('First', 1); const b = seed('Second', 2);
    expect(await run(f, { ids: [a, b] })).toBe(0);
    expect(f.gw.staged).toHaveLength(1);
    expect(f.gw.staged[0]).toMatchObject({ item_count: 2 });
    expect(JSON.parse(Buffer.from(f.gw.completes[0]!.payloadB64, 'base64').toString()).decisions).toHaveLength(2);
  });
  it('seals what completes: the browser way of opening it gives the same bytes, and the hash and the AAD match', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    const url = urlIn(f.out); const staged = f.gw.staged[0]!;
    const opened = await openInBrowserWay(staged.envelope, keyOf(url), { envelopeId: staged.envelope_id, tenantId: 'T1', userId: 'U1', kind: 'share' });
    expect(opened.toString('base64')).toBe(f.gw.completes[0]!.payloadB64);
    expect(createHash('sha256').update(opened).digest('hex')).toBe(staged.payload_sha256);
    expect(JSON.parse(opened.toString())).toMatchObject({ v: 1, kind: 'share', tenant_id: 'T1', gateway_url: 'https://api.align.test' });
    expect(new URL(url).pathname).toBe(`/share/approve/${f.gw.rowIds.get(staged.envelope_id)}`);
  });
  it('never sends the key: it is in no request, and in the link only after the # (printed once)', async () => {
    const f = fixture({ states: ['pending', 'approved'] }); const id = seed();
    await run(f, { ids: [id] });
    const url = urlIn(f.out); const key = keyOf(url);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.gw.wire.length).toBeGreaterThan(3);                       // positive control: there was wire traffic to search
    expect(f.gw.wire.join('\n')).not.toContain(key);
    expect(new URL(url).search).toBe('');
    expect(url.split('#')[0]).not.toContain(key);
    expect(say(f).split(key)).toHaveLength(2);                          // exactly one occurrence in everything printed
  });
  it('splits more than ten decisions into requests of at most ten, one approval each', async () => {
    const f = fixture(); const ids = Array.from({ length: 11 }, (_, i) => seed(`Decision ${i}`, i + 1));
    expect(await run(f, { ids })).toBe(0);
    expect(f.gw.staged.map((s) => s.item_count)).toEqual([SHARE_BATCH_ITEMS, 1]);
    expect(f.gw.completes).toHaveLength(2);
    expect(say(f)).toContain('Request 1 of 2');
  });
});

describe('what happens when it does not get approved', () => {
  it('declined: says nothing was sent, exits 0, and never completes', async () => {
    const f = fixture({ states: ['pending', 'declined'] }); const id = seed();
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(say(f)).toContain('Declined in your browser. Nothing was sent.');
    expect(f.gw.completes).toHaveLength(0);
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toBeNull();
  });
  it('expired: waits to the gateway\'s expiry, then exits 1 with a restart hint and no completion', async () => {
    const f = fixture({ states: ['pending'] }); const id = seed();
    f.deps.approval.sleep = async (ms) => { f.sleeps.push(ms); clock += 4 * 60_000; };   // a fast clock: each wait is four minutes
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('expired');
    expect(say(f)).toContain('Run the share again');
    expect(f.gw.completes).toHaveLength(0);
    expect(f.gw.gets).toBeLessThan(10);
  });
  it('an approval that lands at the last second is not lost to a clock that runs ahead: one more read at the deadline', async () => {
    const f = fixture({ states: ['pending', 'pending', 'approved'] }); const id = seed();
    f.deps.approval.sleep = async (ms) => { f.sleeps.push(ms); clock += 8 * 60_000; };
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.gw.completes).toHaveLength(1);
  });
  it('Ctrl-C while waiting cancels the request, says so, exits 130 and sends nothing', async () => {
    const f = fixture({ states: ['pending'] }); const id = seed();
    f.gw.onGet = (n) => { if (n === 2) f.abort.abort(); };
    expect(await run(f, { ids: [id] })).toBe(130);
    expect(f.gw.cancels).toEqual([f.gw.rowIds.get(f.gw.staged[0]!.envelope_id)]);
    expect(say(f)).toContain('Cancelled the request. Nothing was sent.');
    expect(f.gw.completes).toHaveLength(0);
  });
  it('Ctrl-C with a gateway that cannot be reached says the cancel did not go through, and still sends nothing', async () => {
    const f = fixture({ states: ['pending'] }); const id = seed();
    f.gw.cancelError = new Error('Cannot reach gateway');
    f.gw.onGet = (n) => { if (n === 1) f.abort.abort(); };
    expect(await run(f, { ids: [id] })).toBe(130);
    expect(say(f)).toContain('Could not reach the gateway to cancel');
    expect(f.gw.completes).toHaveLength(0);
  });
  it('a completion the gateway refuses (410) says the approval was too old and records no share', async () => {
    const f = fixture(); const id = seed();
    f.gw.completeError = Object.assign(new Error('Gateway returned 410 for /x: expired'), { statusCode: 410 });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('too old');
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toBeNull();
  });
  it('a completion with no verdict (500) says to check the team graph, and escapes what the server sent', async () => {
    const f = fixture(); const id = seed();
    f.gw.completeError = Object.assign(new Error('Gateway returned 500: bad\u001b[2Jtext'), { statusCode: 500 });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('did not say whether the share finished');
    expect(say(f)).toContain('bad\\x1b[2Jtext');
    expect(say(f)).not.toContain('\u001b');
  });
});

describe('polling', () => {
  it('starts at 2 s, never shrinks, and stops growing at the cap', async () => {
    const f = fixture({ states: [...Array(12).fill('pending'), 'approved'] }); const id = seed();
    await run(f, { ids: [id] });
    expect(f.sleeps[0]).toBe(POLL_START_MS);
    expect(f.sleeps.length).toBe(12);
    for (let i = 1; i < f.sleeps.length; i++) expect(f.sleeps[i]!).toBeGreaterThanOrEqual(f.sleeps[i - 1]!);
    expect(f.sleeps.at(-1)).toBe(POLL_MAX_MS);
    expect(Math.max(...f.sleeps)).toBe(POLL_MAX_MS);
  });
  it('rides out two failed reads in a row, and gives up on the third without sending', async () => {
    const f = fixture({ states: ['approved'] }); const id = seed();
    let n = 0; f.gw.getError = () => (++n <= 2 ? new Error('Cannot reach gateway') : undefined);
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.gw.completes).toHaveLength(1);
    const g = fixture({ states: ['approved'] }); const id2 = seed('Other', 9);
    g.gw.getError = () => new Error('Cannot reach gateway');
    expect(await run(g, { ids: [id2] })).toBe(1);
    expect(say(g)).toContain('3 times in a row');
    expect(g.gw.completes).toHaveLength(0);
  });
  it('a state it did not cause (completed) stops the run: it is not ours to wait on', async () => {
    const f = fixture({ states: ['completed'] }); const id = seed();
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('already completed');
    expect(f.gw.completes).toHaveLength(0);
  });
});

describe('who may use which path', () => {
  it('required: never calls shareBatch or prompts; --typed and --confirm are refused before anything is staged', async () => {
    const f = fixture({ mode: 'required' }); const id = seed();
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.batches).toBe(0); expect(f.asks).toEqual([]);
    const g = fixture({ mode: 'required' }); const id2 = seed('Two', 2);
    expect(await run(g, { ids: [id2], typed: true })).toBe(1);
    expect(say(g)).toContain('requires approval in your browser');
    expect(await run(g, { ids: [], confirm: 'abcdefghij' })).toBe(1);
    expect(g.gw.staged).toHaveLength(0); expect(g.batches).toBe(0); expect(g.asks).toEqual([]);
  });
  it('available + --typed is the typed flow: it asks at the terminal and posts directly, with nothing staged', async () => {
    const f = fixture({ mode: 'available' }); const id = seed();
    expect(await run(f, { ids: [id], typed: true })).toBe(0);
    expect(f.asks).toHaveLength(1); expect(f.batches).toBe(1);
    expect(f.gw.staged).toHaveLength(0);
  });
  it('available + --confirm without --typed is refused with a pointer, and nothing is sent', async () => {
    const f = fixture({ mode: 'available' }); seed();
    expect(await run(f, { ids: [], confirm: 'abcdefghij' })).toBe(1);
    expect(say(f)).toContain('approved in your browser');
    expect(f.batches).toBe(0); expect(f.gw.staged).toHaveLength(0);
  });
  it.each([['off', 'off' as const], ['no route (older gateway)', null]])('%s: the typed flow, unchanged', async (_n, mode) => {
    const f = fixture({ mode }); const id = seed();
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.asks).toHaveLength(1); expect(f.batches).toBe(1); expect(f.gw.staged).toHaveLength(0);
  });
  it('a config that fails (not a 404) stops the run: no fallback to the typed path, nothing sent', async () => {
    const f = fixture(); const id = seed();
    const real = f.deps.client;
    f.deps.client = () => ({ ...real(), shareRequestsConfig: async () => { throw new Error('Gateway returned 500 for /share-requests/config'); } });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('500');
    expect(f.batches).toBe(0); expect(f.asks).toEqual([]);
  });
  it('inside an agent align launched: the browser path runs (it can ask, not approve), the typed path is refused', async () => {
    const f = fixture({ mode: 'available' }); const id = seed();
    f.deps.wrapped = true;
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.gw.staged).toHaveLength(1); expect(f.gw.completes).toHaveLength(1);
    const g = fixture({ mode: 'available' }); const id2 = seed('Two', 2); g.deps.wrapped = true;
    expect(await run(g, { ids: [id2], typed: true })).toBe(1);
    expect(say(g)).toContain('inside an agent that align launched');
    const h = fixture({ mode: null }); const id3 = seed('Three', 3); h.deps.wrapped = true;
    expect(await run(h, { ids: [id3] })).toBe(1);
    expect(h.batches).toBe(0); expect(h.asks).toEqual([]);
  });
  it('retract is still refused inside an agent', async () => {
    const f = fixture({ mode: 'available' }); const id = seed();
    f.deps.wrapped = true;
    expect(await run(f, { retract: id })).toBe(1);
    expect(say(f)).toContain('inside an agent that align launched');
  });
});

describe('a match that waits on the team\'s text', () => {
  const matched = (n: number): BatchResponse => ({
    matched: Array.from({ length: n }, (_, i) => ({ request_index: i, existing_id: 'TEAM1', status: 'active', team_text_hash: TH, needs_confirmation: [{ kind: 'ratify', judgement_index: 0 }] })),
    judgements: Array.from({ length: n }, (_, i) => ({ request_index: i, decision_id: 'TEAM1', results: [{ ok: false, error: 'needs_confirmation' }] })),
  });
  it('stages a second request of kind confirm_team_text carrying the hash, approves it in the browser, and never prompts or reads the team text here', async () => {
    const f = fixture(); const id = seed();
    f.gw.replies.push(matched(1), { matched: [{ request_index: 0, existing_id: 'TEAM1', status: 'active' }], judgements: [{ request_index: 0, decision_id: 'TEAM1', results: [{ ok: true, stored: true }] }] });
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.gw.staged.map((s) => s.kind)).toEqual(['share', 'confirm_team_text']);
    const second = f.gw.staged[1]!;
    const plain = JSON.parse((await openInBrowserWay(second.envelope, keyOf(f.out.filter((l) => l.includes('Approve in your browser')).at(-1)!.split(' ').at(-1)!), { envelopeId: second.envelope_id, tenantId: 'T1', userId: 'U1', kind: 'confirm_team_text' })).toString());
    expect(plain.confirm).toEqual({ decision_id: 'TEAM1', team_text_hash: TH });
    expect(plain.decisions[0].judgements).toEqual([expect.objectContaining({ kind: 'ratify', confirm_team_text_hash: TH })]);
    expect(f.gw.completes).toHaveLength(2);
    expect(f.asks).toEqual([]); expect(f.teamReads).toBe(0); expect(f.batches).toBe(0);
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ confirmPending: false });
  });
  it('refuses to stage a confirmation whose hash is not 64 lowercase hex: no second request, a warning, ratify left unconfirmed', async () => {
    for (const bad of ['th-1', 'A'.repeat(64), 'a'.repeat(63)]) {
      const f = fixture(); const id = seed(`Bad ${bad.length}`, bad.length);
      f.gw.replies.push({ ...matched(1), matched: [{ request_index: 0, existing_id: 'TEAM1', status: 'active', team_text_hash: bad, needs_confirmation: [{ kind: 'ratify', judgement_index: 0 }] }] });
      expect(await run(f, { ids: [id] })).toBe(0);
      expect(f.gw.staged.map((s) => s.kind)).toEqual(['share']);
      expect(say(f)).toContain('does not recognise');
      expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ confirmPending: true });
    }
  });
  it('a declined second approval leaves the ratify unconfirmed and says so', async () => {
    const f = fixture({ states: ['approved', 'declined'] }); const id = seed();
    f.gw.replies.push(matched(1));
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.gw.completes).toHaveLength(1);
    expect(say(f)).toContain('Declined in your browser');
    expect(say(f)).toContain('your ratify was not confirmed');
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ confirmPending: true });
  });
});

describe('what is staged', () => {
  it('refuses to stage an item that carries no client_key: nothing reaches the gateway', async () => {
    const f = fixture(); const id = seed();
    const { buildPlaintext } = await import('../lib/share/envelope.js');
    expect(() => buildPlaintext({ kind: 'share', tenantId: 'T1', gatewayUrl: 'g', payloads: [{ localId: 'x', hash: 'h', fullHash: 'f', deferredPairs: [], shown: [], leftLocal: [], item: { source_url: 'u', platform: 'github', title: 'No key', summary: 's', raw_text: 's', client_key: '', judgements: [] } }] })).toThrow(/no client_key/);
    expect(await run(f, { ids: [id] })).toBe(0);   // positive control: a real share item does carry a key
    expect(JSON.parse(Buffer.from(f.gw.completes[0]!.payloadB64, 'base64').toString()).decisions[0].client_key).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('seals to the signed-in user: a different user id or kind does not open it, and a gateway that does not say who you are stages nothing', async () => {
    const f = fixture(); const id = seed();
    await run(f, { ids: [id] });
    const url = urlIn(f.out); const st = f.gw.staged[0]!;
    await expect(openInBrowserWay(st.envelope, keyOf(url), { envelopeId: st.envelope_id, tenantId: 'T1', userId: 'U2', kind: 'share' })).rejects.toThrow();
    await expect(openInBrowserWay(st.envelope, keyOf(url), { envelopeId: st.envelope_id, tenantId: 'T1', userId: 'U1', kind: 'confirm_team_text' })).rejects.toThrow();
    const g = fixture(); const id2 = seed('Two', 2);
    const real = g.deps.client;
    g.deps.client = () => ({ ...real(), whoami: async () => ({ user: { email: ME }, tenant: { id: 'T1', name: 'Acme' } }) });
    expect(await run(g, { ids: [id2] })).toBe(1);
    expect(say(g)).toContain('did not say who you are signed in as');
    expect(g.gw.staged).toHaveLength(0);
  });
});

describe('groupForApproval', () => {
  const big = (n: number, kb: number): SharePayload => ({
    localId: `l${n}`, hash: 'h', fullHash: 'f', deferredPairs: [], shown: [], leftLocal: [],
    item: { source_url: `https://x/${n}`, platform: 'github', title: `T${n}`, summary: 's', raw_text: 'x'.repeat(kb * 1000), client_key: `k${n}`, judgements: [] },
  });
  const to = { tenantId: 'T', userId: 'U', gatewayUrl: 'https://g' };
  it('packs by count (10) and by sealed size (262,116 bytes), in order', () => {
    expect(groupForApproval(Array.from({ length: 21 }, (_, i) => big(i, 1)), to).map((g) => g.length)).toEqual([10, 10, 1]);
    expect(groupForApproval([big(1, 100), big(2, 100), big(3, 100)], to).map((g) => g.length)).toEqual([2, 1]);
  });
  it('refuses a single decision that cannot be sealed alone, naming it and sending nothing', () => {
    expect(() => groupForApproval([big(1, 10), big(2, 300)], to)).toThrow(ShareError);
    expect(() => groupForApproval([big(2, 300)], to)).toThrow(/"T2" is too large/);
  });
});

/**
 * Security review fixes (ALI-1540):
 * - a failure in the SECOND (confirm) request is a warning: the first share is still reported and recorded, and nothing says "nothing sent".
 * - an item is sized by the larger of its share and its confirm request.
 * - a hung status read does not outlive Ctrl-C; a far-future expiry cannot keep the poll alive.
 * - 409 already_completing says it may have been sent; a plain 409 still says nothing was sent.
 * - an agent's run says so (agent 'wrapped'); a person's does not.
 * - a tenant or user id that could make the AAD ambiguous is refused before staging.
 * - the typed fallback says it is the fallback.
 */
describe('a failure in the confirmation step is not a report that nothing happened', () => {
  const matchedReply = (): BatchResponse => ({
    matched: [{ request_index: 0, existing_id: 'TEAM1', status: 'active', team_text_hash: TH, needs_confirmation: [{ kind: 'ratify', judgement_index: 0 }] }],
    judgements: [{ request_index: 0, decision_id: 'TEAM1', results: [{ ok: false, error: 'needs_confirmation' }] }],
  });
  const failSecondStage = (f: Fx, message: string): void => {
    const real = f.deps.client; let stages = 0;
    f.deps.client = () => ({ ...real(), stageShareRequest: async (b, s) => { if (++stages === 2) throw Object.assign(new Error(message), { statusCode: 429 }); return f.gw.api.stageShareRequest(b, s); } });
  };
  it('a 429 staging the second request: the first result is printed and recorded, the warning names the confirmation, stderr never says nothing was sent', async () => {
    const f = fixture(); const id = seed(); f.gw.replies.push(matchedReply());
    failSecondStage(f, 'Gateway returned 429 for /share-requests: too_many_open_share_requests');
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.out.join('\n')).toContain('matched an existing team decision');
    expect(f.err.join('\n')).toContain('did not finish');
    expect(f.err.join('\n')).toContain('already went through');
    expect(f.err.join('\n')).not.toMatch(/nothing (is|was) sent/i);
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ remoteId: 'TEAM1', confirmPending: true });
  });
  it('three failed status reads while waiting on the second request: the same, and the poll message does not claim anything about sending', async () => {
    const f = fixture({ states: ['approved'] }); const id = seed(); f.gw.replies.push(matchedReply());
    f.gw.getError = () => (f.gw.staged.length >= 2 ? new Error('Cannot reach gateway') : undefined);
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.err.join('\n')).toContain('3 times in a row');
    expect(f.err.join('\n')).not.toMatch(/nothing (is|was) sent/i);
    expect(getPromotion(dbPath, id, 'prod', 'T1')).toMatchObject({ confirmPending: true });
  });
  it('a refused second completion says the share went through, not that nothing was sent', async () => {
    const f = fixture(); const id = seed(); f.gw.replies.push(matchedReply());
    const real = f.gw.api.completeShareRequest; let n = 0;
    f.gw.api.completeShareRequest = async (i, b) => { if (++n === 2) throw Object.assign(new Error('Gateway returned 409 for /x: payload_mismatch'), { statusCode: 409 }); return real(i, b); };
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.err.join('\n')).toContain('the gateway refused it');
    expect(f.err.join('\n')).not.toMatch(/nothing (is|was) sent/i);
  });
  it('the second request is part of an item\'s size: an item whose share fits but whose confirmation would not is refused up front', () => {
    const to = { tenantId: 'T', userId: 'U', gatewayUrl: 'https://g' };
    const judgements = Array.from({ length: 50 }, (_, i) => ({ kind: 'note' as const, note: `n${i}`, judged_at: '2026-09-04T10:00:00.000Z', origin: 'local_share' as const }));
    const mk = (kb: number): SharePayload => ({ localId: 'l', hash: 'h', fullHash: 'f', deferredPairs: [], shown: [], leftLocal: [], item: { source_url: 'u', platform: 'github', title: 'T', summary: 's', raw_text: 'x'.repeat(kb), client_key: 'k', judgements } });
    const shareSize = (n: number): number => buildPlaintext({ kind: 'share', ...to, payloads: [mk(n)] }).length;
    const fill = MAX_PLAINTEXT_BYTES - shareSize(0) - 100;   // the share fits with 100 bytes to spare; the confirm shape adds ~5 kB
    expect(shareSize(fill)).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
    expect(() => groupForApproval([mk(fill)], to)).toThrow(/too large to approve/);
    expect(groupForApproval([mk(fill - 8000)], to)).toHaveLength(1);
  });
});

describe('Ctrl-C and a hostile gateway', () => {
  it('a status read that hangs does not outlive Ctrl-C: exit 130 inside a second, and the request is cancelled', async () => {
    const f = fixture({ states: ['pending'] }); const id = seed();
    const real = f.deps.client;
    f.deps.client = () => ({ ...real(), getShareRequest: (_id: string, signal?: AbortSignal) => new Promise<never>((_r, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
    setTimeout(() => f.abort.abort(), 50);
    const t0 = Date.now();
    expect(await run(f, { ids: [id] })).toBe(130);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.gw.cancels).toHaveLength(1);
    expect(f.gw.completes).toHaveLength(0);
  });
  it('an abort before the next group is staged stops there', async () => {
    const f = fixture(); const ids = Array.from({ length: 11 }, (_, i) => seed(`D${i}`, i + 1));
    const real = f.gw.api.completeShareRequest;
    f.gw.api.completeShareRequest = async (i, b) => { const r = await real(i, b); f.abort.abort(); return r; };
    expect(await run(f, { ids })).toBe(130);
    expect(f.gw.staged).toHaveLength(1);
    expect(f.err.join('\n')).toContain('Cancelled before it was staged');
  });
  it('a far-future expires_at is clamped to the config lifetimes (25 minutes): the poll ends, it does not run for years', async () => {
    const f = fixture({ states: ['pending'] }); const id = seed();
    f.gw.expiresAt = '2099-01-01T00:00:00.000Z';
    f.deps.approval.sleep = async (ms) => { f.sleeps.push(ms); clock += 5 * 60_000; };
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('expired');
    expect(f.gw.gets).toBeLessThan(12);
  });
});

describe('what the completion errors say', () => {
  it('409 already_completing says it MAY have been sent, and that this machine has no record, never "Nothing was sent"', async () => {
    const f = fixture(); const id = seed();
    f.gw.completeError = Object.assign(new Error('Gateway returned 409 for /x: already_completing'), { statusCode: 409 });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('may have been sent');
    expect(say(f)).toContain('no record');
    expect(say(f)).not.toContain('Nothing was sent.');
  });
  it('a plain 409 (not approved) still says nothing was sent', async () => {
    const f = fixture(); const id = seed();
    f.gw.completeError = Object.assign(new Error('Gateway returned 409 for /x: not_approved'), { statusCode: 409 });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('Nothing was sent.');
  });
});

describe('who the request says staged it, and what it is sealed to', () => {
  it('inside an agent align launched the request carries agent "wrapped"; a person\'s run carries none', async () => {
    const f = fixture(); const id = seed(); f.deps.wrapped = true;
    await run(f, { ids: [id] });
    expect(f.gw.staged[0]!.agent).toBe('wrapped');
    const g = fixture(); const id2 = seed('Two', 2);
    await run(g, { ids: [id2] });
    expect(g.gw.staged[0]).not.toHaveProperty('agent');
  });
  it.each([['tenant', 'T|1', 'U1'], ['user', 'T1', 'U|1'], ['user with a space', 'T1', 'U 1'], ['user with a newline', 'T1', 'U\n1']])('a %s id that could make the AAD ambiguous is refused before anything is staged', async (_n, tenant, user) => {
    const f = fixture(); const id = seed();
    const real = f.deps.client;
    f.deps.client = () => ({ ...real(), whoami: async () => ({ user: { email: ME, id: user }, tenant: { id: tenant, name: 'Acme' } }) });
    expect(await run(f, { ids: [id] })).toBe(1);
    expect(say(f)).toContain('not a plain identifier');
    expect(f.gw.staged).toHaveLength(0);
  });
});

describe('no silent downgrade to the typed answer', () => {
  it.each([['no route (404)', null, /does not offer browser approval/], ['mode off', 'off' as const, /turned off/]])('%s: one line says why this asks at the terminal', async (_n, mode, re) => {
    const f = fixture({ mode }); const id = seed();
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.out.join('\n')).toMatch(re);
    expect(f.asks).toHaveLength(1);
  });
  it('an explicit --typed in available mode needs no such line (the person chose it)', async () => {
    const f = fixture({ mode: 'available' }); const id = seed();
    await run(f, { ids: [id], typed: true });
    expect(f.out.join('\n')).not.toMatch(/browser approval/);
  });
});

describe('delivery of the approval link (QR, open, narrow terminal)', () => {
  const qr = (url: string) => ({ lines: [`\u001b[38;5;16;48;5;231m▀\u001b[0m ${url.length}`], columns: 30 });
  it('prints the QR after the link when the plan asks for one, does not open, and keeps the colour escapes intact', async () => {
    const f = fixture(); const id = seed();
    f.deps.approval.openUrl = undefined; f.deps.approval.plan = { open: false, qr: true, qrIfOpenFails: true, why: 'ssh' }; f.deps.approval.qr = qr;
    const raw: string[] = []; const outer = f.deps.out; f.deps.out = (l) => { raw.push(l); outer(l); };
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.opened).toEqual([]);
    const lines = f.out;
    const at = lines.findIndex((l) => l.includes('Scan this with your phone camera'));
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.startsWith('Approve in your browser:')));
    expect(lines[at + 1]).toContain('\u001b[38;5;16;48;5;231m');   // not neutralised by the output cleaning
    expect(lines.join('\n')).toMatch(/scan the QR code with your phone/);
  });
  it('prints no QR and opens nothing when the plan has neither (CI, a pipe), and still says how to open the link', async () => {
    const f = fixture(); const id = seed();
    f.deps.approval.plan = { open: false, qr: false, qrIfOpenFails: false, why: 'ci' }; f.deps.approval.qr = qr;
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.opened).toEqual([]); expect(say(f)).not.toContain('Scan this'); expect(say(f)).toMatch(/open the link above/);
  });
  it('a terminal too narrow for the code gets a sentence and no code', async () => {
    const f = fixture(); const id = seed();
    f.deps.approval.plan = { open: false, qr: true, qrIfOpenFails: true, why: 'ssh' }; f.deps.approval.qr = qr; f.deps.approval.columns = 20;
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(say(f)).toMatch(/20 columns wide and the QR code needs 30/); expect(say(f)).not.toContain('Scan this');
  });
  it('a gateway that returns an id with a shell metacharacter in it gets no browser and no QR', async () => {
    const f = fixture(); const id = seed();
    f.deps.approval.plan = { open: true, qr: true, qrIfOpenFails: true, why: 't' }; f.deps.approval.qr = qr;
    f.deps.approval.appUrl = 'https://app.align.test"; calc; "';
    expect(await run(f, { ids: [id] })).toBe(0);
    expect(f.opened).toEqual([]); expect(say(f)).not.toContain('Scan this'); expect(say(f)).toMatch(/does not have the shape/);
  });
});
