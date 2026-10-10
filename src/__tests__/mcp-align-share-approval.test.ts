import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchTool, instructionsFor, TOOL_SCHEMAS } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { upsertJudgement } from '../lib/curation/judgements-db.js';
import { createLocalDb } from '../lib/local-db.js';
import { runShareStatusTool } from '../lib/mcp/share-status-tool.js';
import { runShareTool, SHARE_STATUS_TOOL, SHARE_TOOL } from '../lib/mcp/share-tool.js';
import { loadRequest } from '../lib/share/pending.js';
import { fakeRequests, type FakeRequests, keyOf, openInBrowserWay } from './helpers/share-requests-fake.js';

/**
 * ALI-1540 Test List, the MCP tools:
 * - align_share (browser approval): returns the link (key in the fragment), the code and the request id, in words that say the
 *   agent cannot approve; makes NO completion call and never calls shareBatch; the request is kept 0600 on this machine.
 *   Asking again returns the same link and stages nothing; once the gateway no longer has it pending, it stages a fresh one.
 * - align_share_status: waiting/declined/expired/cancelled complete nothing and clear the record. Approved completes ONCE with the
 *   exact bytes the browser opened; a second call completes nothing. A share that changed since the person saw it is cancelled
 *   and not sent. A completion with no verdict keeps the record so the same bytes can be sent again; a refusal clears it.
 * - no sequence of tool calls completes a share the person has not approved.
 * - on a gateway without the route, align_share is still the older one-time code.
 * - the tool descriptions carry the guidance; the server instructions stay exactly as long as they were (1968 of 2048 bytes).
 */
let dir: string; let dbPath: string; let env: EnvironmentConfig; let id: string;
const cloud = { mode: 'auth', gatewayUrl: 'https://api.align.test', authToken: 't', tenantId: 'T1' } as EnvironmentConfig;
let gw: FakeRequests; let batches = 0;
const client = () => ({
  ...gw.api,
  whoami: async () => ({ user: { email: 'me@co.com', id: 'U1' }, tenant: { id: 'T1', name: 'Acme' } }),
  shareBatch: async () => { batches++; return {}; },
  getDecision: async () => ({}), archiveDecision: async () => undefined,
});
const ctx = () => ({ clientInfo: { name: 'claude-code' }, judge: async () => ({ judgeId: 'i', judgeLabel: null }), share: { cloudEnv: cloud, envName: 'prod', client: client(), salt: 'salt-1', appUrl: 'https://app.align.test', label: 'tom-laptop' } });
const urlOf = (r: { approve_url?: unknown }): string => String(r.approve_url);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-mcp2-'));
  vi.stubEnv('XDG_STATE_HOME', path.join(dir, 'state')); fs.mkdirSync(path.join(dir, 'state'));
  dbPath = path.join(dir, 'g.db');
  const db = createLocalDb(dbPath);
  id = db.insertDecision({ title: 'Use sqlite', summary: 'because node', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github' });
  db.markRatified(id, 'me@co.com'); db.close();
  env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath } as EnvironmentConfig;
  gw = fakeRequests({ states: ['pending'] }); batches = 0;
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('align_share with browser approval', () => {
  it('stages, returns the link, the code and the id in plain words, and completes nothing', async () => {
    const r = await runShareTool({ id }, env, ctx());
    expect(r.text).toContain('NOTHING HAS BEEN SENT');
    expect(r.text).toContain(urlOf(r));
    expect(r.text).toContain('Code: KJ4M-9XQT');
    expect(r.text).toContain(String(r['request_id']));
    expect(r.text).toMatch(/do not try to approve it yourself/);
    expect(r.text).toContain(SHARE_STATUS_TOOL);
    expect(r.text).toContain('To: Acme (prod) as me@co.com');
    expect(new URL(urlOf(r)).hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);
    expect(gw.staged).toHaveLength(1);
    expect(gw.staged[0]).toMatchObject({ kind: 'share', requester_label: 'tom-laptop', agent: 'claude-code' });
    expect(gw.completes).toHaveLength(0); expect(batches).toBe(0);
    expect(r.code).toBeUndefined();   // no older one-time code in this mode
  });
  it('never sends the key to the gateway, and the browser way of opening the envelope gives the staged request', async () => {
    const r = await runShareTool({ id }, env, ctx());
    const staged = gw.staged[0]!;
    expect(gw.wire.join('\n')).not.toContain(keyOf(urlOf(r)));
    const plain = JSON.parse((await openInBrowserWay(staged.envelope, keyOf(urlOf(r)), { envelopeId: staged.envelope_id, tenantId: 'T1', userId: 'U1', kind: 'share' })).toString());
    expect(plain.decisions[0].title).toBe('Use sqlite');
  });
  it('keeps the request 0600 on this machine, and the same link comes back while the gateway still has it pending', async () => {
    const r = await runShareTool({ id }, env, ctx());
    const rec = loadRequest(String(r['request_id']))!;
    expect(rec.keyB64Url).toBe(keyOf(urlOf(r)));
    if (process.platform !== 'win32') {
      const f = path.join(dir, 'state', 'align-cli', 'pending-requests', `${rec.requestId}.json`);
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    }
    const again = await runShareTool({ id }, env, ctx());
    expect(urlOf(again)).toBe(urlOf(r));
    expect(gw.staged).toHaveLength(1);
  });
  it('stages a fresh one when the gateway no longer has the old one pending', async () => {
    const r = await runShareTool({ id }, env, ctx());
    gw.states = ['expired'];
    const again = await runShareTool({ id }, env, ctx());
    expect(again['request_id']).not.toBe(r['request_id']);
    expect(gw.staged).toHaveLength(2);
    expect(loadRequest(String(r['request_id']))).toBeNull();
  });
  it('required mode stages too, and an older gateway still gets the one-time code', async () => {
    gw.mode = 'required';
    expect((await runShareTool({ id }, env, ctx())).code).toBeUndefined();
    gw.mode = null;
    const old = await runShareTool({ id }, env, ctx());
    expect(old.code).toMatch(/^[a-z2-7]{10}$/);
    expect(old.text).toContain('must not run it');
    expect(gw.staged).toHaveLength(1);
  });
  it('a config that fails is an error, not a fall back to the older code', async () => {
    const c = ctx(); const real = c.share.client;
    c.share.client = { ...real, shareRequestsConfig: async () => { throw new Error('Gateway returned 500 for /share-requests/config'); } };
    await expect(runShareTool({ id }, env, c)).rejects.toThrow(/500/);
    expect(gw.staged).toHaveLength(0);
  });
  it('a decision too large to seal stages nothing and says so', async () => {
    const db = createLocalDb(dbPath);
    const big = db.insertDecision({ title: 'Big', summary: 'x'.repeat(200_000), sourceUrl: 'https://github.com/o/r/pull/9', platform: 'github' });
    db.markRatified(big, 'me@co.com'); db.close();
    const r = await runShareTool({ id: big }, env, ctx());
    expect(r.text).toContain('too large to approve in one request');
    expect(gw.staged).toHaveLength(0);
  });
});

async function staged(decision: string = id): Promise<{ id: string; url: string }> {
  const r = await runShareTool({ id: decision }, env, ctx());
  expect(r['request_id'], 'a request was staged (an already-shared decision stages nothing)').toBeDefined();
  return { id: String(r['request_id']), url: urlOf(r) };
}

describe('align_share_status', () => {
  it('while it is waiting: says so, completes nothing, keeps the request', async () => {
    const s = await staged();
    const r = await runShareStatusTool({ request_id: s.id }, env, ctx());
    expect(r.text).toContain('Still waiting for the user to approve');
    expect(gw.completes).toHaveLength(0);
    expect(loadRequest(s.id)).not.toBeNull();
  });
  it.each([['declined', /declined/], ['expired', /expired/], ['cancelled', /cancelled/], ['failed', /failed/]])('%s: reports it, completes nothing and clears the request', async (state, re) => {
    const s = await staged(); gw.states = [state];
    const r = await runShareStatusTool({ request_id: s.id }, env, ctx());
    expect(r.text).toMatch(re); expect(r.text).toContain('Nothing was sent');
    expect(gw.completes).toHaveLength(0);
    expect(loadRequest(s.id)).toBeNull();
  });
  it('approved: completes once with the exact bytes the browser opened, records the share, and a second call completes nothing', async () => {
    const s = await staged(); gw.states = ['approved'];
    const r = await runShareStatusTool({ request_id: s.id }, env, ctx());
    expect(r.text).toContain('Approved by the user, and sent');
    expect(r.text).toContain('created: R0');
    expect(gw.completes).toHaveLength(1);
    const st = gw.staged[0]!;
    const opened = await openInBrowserWay(st.envelope, keyOf(s.url), { envelopeId: st.envelope_id, tenantId: 'T1', userId: 'U1', kind: 'share' });
    expect(gw.completes[0]!.payloadB64).toBe(opened.toString('base64'));
    expect(batches).toBe(0);
    const again = await runShareStatusTool({ request_id: s.id }, env, ctx());
    expect(again.text).toContain('No share is waiting');
    expect(gw.completes).toHaveLength(1);
  });
  it('two concurrent calls complete it once', async () => {
    const s = await staged(); gw.states = ['approved'];
    await Promise.all([runShareStatusTool({ request_id: s.id }, env, ctx()), runShareStatusTool({ request_id: s.id }, env, ctx())]);
    expect(gw.completes).toHaveLength(1);
  });
  it('a share that changed since the person saw it is cancelled and not sent', async () => {
    const s = await staged(); gw.states = ['approved'];
    upsertJudgement(dbPath, { kind: 'note', decisionId: id, note: 'added after the preview' }, { judgeId: 'i', judgeLabel: null }, { via: 'cli' });
    const r = await runShareStatusTool({ request_id: s.id }, env, ctx());
    expect(r.text).toContain('changed since the user was shown it');
    expect(gw.completes).toHaveLength(0);
    expect(gw.cancels).toEqual([s.id]);
    expect(loadRequest(s.id)).toBeNull();
  });
  it('a completion with no verdict keeps the request so the same bytes can be sent again; a refusal clears it', async () => {
    const s = await staged(); gw.states = ['approved'];
    gw.completeError = Object.assign(new Error('Gateway returned 502'), { statusCode: 502 });
    await expect(runShareStatusTool({ request_id: s.id }, env, ctx())).rejects.toThrow(/did not say whether/);
    expect(loadRequest(s.id)).not.toBeNull();
    gw.completeError = undefined;
    expect((await runShareStatusTool({ request_id: s.id }, env, ctx())).text).toContain('Approved by the user, and sent');
    const db = createLocalDb(dbPath);
    const other = db.insertDecision({ title: 'Other', summary: 'o', sourceUrl: 'https://github.com/o/r/pull/2', platform: 'github' });
    db.markRatified(other, 'me@co.com'); db.close();
    const t = await staged(other); gw.states = ['approved'];
    gw.completeError = Object.assign(new Error('Gateway returned 409: payload_mismatch'), { statusCode: 409 });
    await expect(runShareStatusTool({ request_id: t.id }, env, ctx())).rejects.toThrow(/would not complete it/);
    expect(loadRequest(t.id)).toBeNull();
  });
  it('an unknown id, a malformed id and an unknown property are refused without a gateway call', async () => {
    expect((await runShareStatusTool({ request_id: '0b9f3c1e-5d2a-4f8e-9a77-3c1d2e4f5a6b' }, env, ctx())).text).toContain('No share is waiting');
    expect((await runShareStatusTool({ request_id: '../../etc/passwd' }, env, ctx())).text).toContain('not a share request id');
    await expect(runShareStatusTool({ request_id: 'x', token: 'sk-SECRETVALUE' }, env, ctx())).rejects.toThrow(/does not accept an unknown property/);
    await expect(runShareStatusTool({ request_id: 'x', token: 'sk-SECRETVALUE' }, env, ctx())).rejects.not.toThrow(/SECRETVALUE/);
    expect(gw.gets).toBe(0);
  });
});

describe('what the tools are, and what an agent can reach', () => {
  it('is annotated honestly: align_share_status writes (it completes a share) and is not destructive; align_share stays as it was', () => {
    for (const name of [SHARE_TOOL, SHARE_STATUS_TOOL]) {
      expect(TOOL_SCHEMAS.find((t) => t.name === name)!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
  });
  it('the descriptions say the agent can only ask, and never name the confirm command line', () => {
    const share = TOOL_SCHEMAS.find((t) => t.name === SHARE_TOOL)!.description;
    const status = TOOL_SCHEMAS.find((t) => t.name === SHARE_STATUS_TOOL)!.description;
    expect(share).toMatch(/do not try to approve it yourself/);
    expect(share).not.toMatch(/cannot approve/i);
    expect(share).toMatch(/must not run that command/);
    expect(share).not.toContain('--confirm');
    expect(status).toMatch(/does not approve anything/);
    expect(status).not.toMatch(/cannot approve/i);
    expect(share.length).toBeLessThan(2048); expect(status.length).toBeLessThan(2048);
  });
  it('the server instructions are exactly as long as before this change: 1968 of 2048 bytes in local mode', () => {
    expect(Buffer.byteLength(instructionsFor(env), 'utf8')).toBe(1968);
  });
  it('no sequence of tool calls completes a share nobody approved, and the positive control does once it is approved', async () => {
    const s = await staged();
    const argSets: Array<Record<string, unknown>> = [{}, { id }, { request_id: s.id }, { id, request_id: s.id, confirm: true, action: 'approve' }];
    for (const tool of TOOL_SCHEMAS) {
      const props = ((tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {});
      for (const action of props['action']?.enum ?? [undefined]) {
        for (const base of argSets) {
          await dispatchTool(tool.name, action === undefined ? base : { ...base, action }, { shareBatch: async () => { batches++; return {}; } } as never, env, undefined, ctx() as never).catch(() => undefined);
        }
      }
    }
    expect(gw.completes).toHaveLength(0); expect(batches).toBe(0);
    gw.states = ['approved'];
    await dispatchTool(SHARE_STATUS_TOOL, { request_id: s.id }, {} as never, env, undefined, ctx() as never);
    expect(gw.completes).toHaveLength(1);
  }, 60_000);
  it('a frozen server refuses align_share_status like align_share', async () => {
    await expect(dispatchTool(SHARE_STATUS_TOOL, { request_id: 'x' }, {} as never, env, '2026-01-01T00:00:00.000Z')).rejects.toThrow(/frozen/);
  });
});

/**
 * Security review fixes (ALI-1540), the MCP side:
 * - a status call rebuilds the bytes: a pending file edited to name another decision's hash and ids is cancelled and sends nothing.
 * - a completed request this machine has no ledger row for says so (a lost completion answer), and a recorded one says it has it.
 * - asking again while the earlier request cannot be checked (a temporary error) keeps its file and stages nothing new.
 * - request files are swept once past their expiry plus the completion window, and not before.
 * - the older one-time code says it is the older flow.
 */
describe('a pending file edited to point at something else', () => {
  it('stage X and Y, copy Y\'s hash and ids into X\'s file: status on X is refused, cancelled, and records nothing under Y', async () => {
    const db = createLocalDb(dbPath);
    const y = db.insertDecision({ title: 'Y decision', summary: 'y', sourceUrl: 'https://github.com/o/r/pull/77', platform: 'github' });
    db.markRatified(y, 'me@co.com'); db.close();
    const x = await staged(); const yy = await staged(y);
    const dirOf = path.join(dir, 'state', 'align-cli', 'pending-requests');
    const xFile = path.join(dirOf, `${x.id}.json`);
    const xRec = JSON.parse(fs.readFileSync(xFile, 'utf8')); const yRec = JSON.parse(fs.readFileSync(path.join(dirOf, `${yy.id}.json`), 'utf8'));
    fs.writeFileSync(xFile, JSON.stringify({ ...xRec, hash: yRec.hash, localIds: yRec.localIds }));
    gw.states = ['approved'];
    const r = await runShareStatusTool({ request_id: x.id }, env, ctx());
    expect(r.text).toContain('changed since the user was shown it');
    expect(gw.completes).toHaveLength(0);
    expect(gw.cancels).toEqual([x.id]);
    const { getPromotion } = await import('../lib/share/ledger.js');
    expect(getPromotion(dbPath, y, 'prod', 'T1')).toBeNull();
  });
  it('a file whose bytes were swapped but whose hash and ids are left alone is refused too', async () => {
    const x = await staged();
    const f = path.join(dir, 'state', 'align-cli', 'pending-requests', `${x.id}.json`);
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...rec, bytesB64: Buffer.from(Buffer.from(rec.bytesB64, 'base64').toString().replace('Use sqlite', 'Use mongodb')).toString('base64') }));
    gw.states = ['approved'];
    expect((await runShareStatusTool({ request_id: x.id }, env, ctx())).text).toContain('changed since the user was shown it');
    expect(gw.completes).toHaveLength(0);
  });
});

describe('a lost completion answer', () => {
  it('a 502, then the gateway says completed: the text says this machine has NO record, and that sharing again records it', async () => {
    const s = await staged(); gw.states = ['approved'];
    gw.completeError = Object.assign(new Error('Gateway returned 502'), { statusCode: 502 });
    await expect(runShareStatusTool({ request_id: s.id }, env, ctx())).rejects.toThrow(/may have been sent/);
    gw.completeError = undefined; gw.states = ['completed'];
    const r = await runShareStatusTool({ request_id: s.id }, env, ctx());
    expect(r.text).toContain('NO record');
    expect(r.text).toContain('retract');
    expect(r.text).not.toContain('already completed, and this machine has the record');
    expect(loadRequest(s.id)).toBeNull();
  });
  it('a completed request whose ledger row exists says it has the record', async () => {
    const s = await staged();
    const { recordPromotion } = await import('../lib/share/ledger.js');
    recordPromotion(dbPath, { localId: id, env: 'prod', tenantId: 'T1', contentHash: 'f', clientKey: 'k', sent: [], confirmPending: false, remoteId: 'R0', matched: false });
    gw.states = ['completed'];
    expect((await runShareStatusTool({ request_id: s.id }, env, ctx())).text).toContain('this machine has the record');
  });
  it('409 already_completing says it may have been sent and keeps the file (the same bytes may be sent again)', async () => {
    const s = await staged(); gw.states = ['approved'];
    gw.completeError = Object.assign(new Error('Gateway returned 409 for /x: already_completing'), { statusCode: 409 });
    await expect(runShareStatusTool({ request_id: s.id }, env, ctx())).rejects.toThrow(/may have been sent/);
    expect(loadRequest(s.id)).not.toBeNull();
  });
});

describe('asking again while the earlier request cannot be checked', () => {
  it('a temporary error keeps the local file and stages nothing new; a 404 (the gateway forgot it) stages a fresh one', async () => {
    const r = await runShareTool({ id }, env, ctx());
    const c = ctx(); const real = c.share.client;
    c.share.client = { ...real, getShareRequest: async () => { throw Object.assign(new Error('Gateway returned 502'), { statusCode: 502 }); } };
    await expect(runShareTool({ id }, env, c)).rejects.toThrow(/no new one was staged/);
    expect(gw.staged).toHaveLength(1);
    expect(loadRequest(String(r['request_id']))).not.toBeNull();
    c.share.client = { ...real, getShareRequest: async () => { throw Object.assign(new Error('Gateway returned 404'), { statusCode: 404 }); } };
    const again = await runShareTool({ id }, env, c);
    expect(again['request_id']).not.toBe(r['request_id']);
    expect(gw.staged).toHaveLength(2);
  });
});

describe('request files do not outlive their usefulness', () => {
  it('are swept 11 minutes past their expiry, and kept inside that window', async () => {
    const { saveRequest, sweepPending } = await import('../lib/share/pending.js');
    const mk = (n: number, expiresAt: string) => ({ requestId: `0b9f3c1e-5d2a-4f8e-9a77-3c1d2e4f5a6${n}`, kind: 'share' as const, envName: 'prod', tenantId: 'T1', gatewayUrl: 'g', keyB64Url: 'k', bytesB64: 'b', sha256: 's', hash: 'h', localIds: ['l'], agentId: 'a', userCode: 'KJ4M-9XQT', expiresAt });
    const expiry = new Date('2026-10-10T12:00:00.000Z');
    expect(saveRequest(mk(1, expiry.toISOString()))).toBe(true); expect(saveRequest(mk(2, expiry.toISOString()))).toBe(true);
    expect(sweepPending(new Date(expiry.getTime() + 10 * 60_000))).toBe(0);                  // still inside the completion window: kept
    expect(loadRequest(mk(1, '').requestId)).not.toBeNull();
    expect(sweepPending(new Date(expiry.getTime() + 11 * 60_000 + 1000))).toBe(2);          // past it: gone, no 24 h wait
    expect(loadRequest(mk(1, '').requestId)).toBeNull();
  });
});

describe('the older one-time code says it is the older flow', () => {
  it('on a gateway with no browser approval the text says so', async () => {
    gw.mode = null;
    const r = await runShareTool({ id }, env, ctx());
    expect(r.text).toContain('does not offer browser approval');
    expect(r.code).toMatch(/^[a-z2-7]{10}$/);
  });
});
