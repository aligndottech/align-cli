import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGatewayClient } from '../lib/gateway-client.js';
import { createLocalDb } from '../lib/local-db.js';
import { exportLedger, getPromotion, recordPromotion, restoreLedger } from '../lib/share/ledger.js';
import { consumeCode, issueCode, lookupCode, sweepPending } from '../lib/share/pending.js';
import type { SharePayload } from '../lib/share/payload.js';

/**
 * L9 security review, items 9 and 10:
 * - shareBatch and archiveDecision never follow a redirect (a 30x to another host would carry the bearer token and the decision text).
 * - consumeCode is atomic: of two racers exactly one wins.
 * - pending code files older than 24h are swept (and a fresh one is not); the sweep touches nothing but its own directory.
 * - `align local reset` keeps the promotions ledger so a share stays retractable: export before the wipe, restore after, nothing else survives.
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-hard-')); vi.stubEnv('XDG_STATE_HOME', path.join(dir, 'state')); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('redirects', () => {
  it('shareBatch and archiveDecision ask fetch to error on a redirect, and an ordinary call does not', async () => {
    const seen: Array<{ url: string; redirect?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { redirect?: string }) => { seen.push({ url, redirect: init?.redirect }); return new Response('{}', { status: 200 }); }));
    const c = createGatewayClient({ mode: 'auth', gatewayUrl: 'https://gw.test', authToken: 't', tenantId: 'T' });
    await c.shareBatch([{ title: 'x' }]);
    await c.archiveDecision('abc');
    await c.whoami();
    vi.unstubAllGlobals();
    expect(seen.map((s) => [s.url.replace('https://gw.test', ''), s.redirect])).toEqual([['/ingest/batch', 'error'], ['/decisions/abc/archive', 'error'], ['/auth/me', undefined]]);
  });
});

const payload = (id: string): SharePayload => ({ localId: id, item: {} as never, shown: [], leftLocal: [], deferredPairs: [], hash: `h-${id}`, fullHash: `f-${id}` });
const meta = { agentId: 'codex', envName: 'prod', preview: 'p', to: { tenantId: 'T', gatewayUrl: 'https://x' } };

describe('a server error body', () => {
  it('is escaped where the gateway client builds the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad\u001b[2J' }), { status: 500 })));
    const c = createGatewayClient({ mode: 'auth', gatewayUrl: 'https://gw.test', authToken: 't', tenantId: 'T' });
    const msg = await c.shareBatch([{ title: 'x' }]).then(() => '', (e: Error) => e.message);
    vi.unstubAllGlobals();
    expect(msg).toContain('bad\\x1b[2J');
    expect(msg).not.toContain('\u001b');
  });
});

describe('pending codes', () => {
  it('consumeCode is single use: the second consume of the same code loses', () => {
    const code = issueCode([payload('a')], meta)!;
    expect(consumeCode(code)).toBe(true);
    expect(consumeCode(code)).toBe(false);
    expect(lookupCode(code)).toEqual({ ok: false, reason: 'unknown' });
  });
  it('sweeps files older than 24 hours and keeps a fresh one', () => {
    const old = issueCode([payload('old')], meta)!;
    const fresh = issueCode([payload('fresh')], meta)!;
    const dirOf = path.join(dir, 'state', 'align-cli', 'pending-shares');
    const when = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(path.join(dirOf, `${old}.json`), when, when);
    expect(sweepPending()).toBe(1);
    expect(fs.existsSync(path.join(dirOf, `${old}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dirOf, `${fresh}.json`))).toBe(true);
    expect(sweepPending()).toBe(0);
  });
  it('a sweep with no state directory is a no-op', () => { expect(sweepPending()).toBe(0); });
});

describe('the ledger survives a reset', () => {
  it('exports every row and restores them into a fresh graph, retraction included, with nothing else', () => {
    const a = path.join(dir, 'a.db');
    createLocalDb(a).close();
    const row = { localId: 'L1', env: 'prod', tenantId: 'T1', remoteId: 'R1', contentHash: 'h', matched: false, clientKey: 'k', sent: ['s1'], confirmPending: false };
    recordPromotion(a, row);
    recordPromotion(a, { ...row, localId: 'L2', remoteId: 'R2', matched: true });
    const kept = exportLedger(a);
    expect(kept).toHaveLength(2);
    fs.rmSync(a);
    const b = path.join(dir, 'b.db');
    const db = createLocalDb(b); db.insertDecision({ title: 'new graph', summary: 's', sourceUrl: 'https://e/1', platform: 'cli' }); db.close();
    restoreLedger(b, kept);
    expect(getPromotion(b, 'L1', 'prod', 'T1')).toMatchObject({ remoteId: 'R1', clientKey: 'k', sent: ['s1'], matched: false });
    expect(getPromotion(b, 'L2', 'prod', 'T1')).toMatchObject({ matched: true });
    restoreLedger(b, kept); // replay-safe
    expect(exportLedger(b)).toHaveLength(2);
  });
  it('an export of a missing or pre-v10 graph is empty', () => {
    expect(exportLedger(path.join(dir, 'none.db'))).toEqual([]);
  });
});
