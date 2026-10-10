import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShare, type ShareDeps } from '../lib/share/command.js';
import { loadRequest, type PendingRequest, saveRequest } from '../lib/share/pending.js';
import { fakeRequests, type FakeRequests } from './helpers/share-requests-fake.js';

/**
 * `align share --open <request id>`: re-open or re-print the link of a request an agent staged (align_share) on THIS machine.
 * It needs the 0600 pending file (the key lives only there), so it cannot work anywhere else, and it never prints a key
 * for a request that is not live, belongs to another environment or gateway, or that the gateway no longer holds pending.
 */
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-open-'));
  for (const k of ['XDG_STATE_HOME', 'LOCALAPPDATA', 'APPDATA']) vi.stubEnv(k, path.join(dir, k));
  fs.mkdirSync(path.join(dir, 'XDG_STATE_HOME'), { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const RID = '123e4567-e89b-42d3-a456-426614174000';
const KEY = 'K'.repeat(43);
const rec = (o: Partial<PendingRequest> = {}): PendingRequest => ({
  requestId: RID, kind: 'share', envName: 'prod', tenantId: 'T1', gatewayUrl: 'https://api.align.test', keyB64Url: KEY, bytesB64: 'AAAA', sha256: 'f'.repeat(64),
  hash: 'h', localIds: ['l1'], agentId: 'agent', userCode: 'KJ4M-9XQT', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), ...o,
});

function rig(init: Parameters<typeof fakeRequests>[0] = { states: ['pending'] }, over: { cloudEnv?: ShareDeps['cloudEnv']; plan?: ShareDeps['approval']['plan'] } = {}) {
  const gw: FakeRequests = fakeRequests(init);
  const out: string[] = []; const err: string[] = []; const opened: string[] = [];
  const deps = {
    cloudEnv: over.cloudEnv ?? { mode: 'auth', gatewayUrl: 'https://api.align.test', authToken: 't', tenantId: 'T1' },
    localDbPath: null, salt: 's', defaultGatewayUrl: 'https://api.align.test', client: () => ({ ...gw.api }), judge: async () => { throw new Error('no'); }, owner: async () => 'x', wrapped: false,
    ttyConfirm: async () => null,
    approval: {
      appUrl: 'https://app.align.test', label: 'l', sleep: async () => undefined, now: () => Date.now(),
      openUrl: async (u: string) => { opened.push(u); return true; }, ...(over.plan ? { plan: over.plan } : {}),
      qr: () => ({ lines: ['QRLINE'], columns: 10 }),
    },
    out: (l: string) => out.push(l), err: (l: string) => err.push(l),
  } as unknown as ShareDeps;
  return { gw, out, err, opened, run: (openRequest: string, envName = 'prod') => runShare({ ids: [], envName, openRequest }, deps), all: () => [...out, ...err].join('\n') };
}

describe('align share --open', () => {
  it('re-opens a live request staged here: prints the full link and the code, opens it per the plan, never completes or cancels', async () => {
    expect(saveRequest(rec())).toBe(true);
    const r = rig({ states: ['pending'] }, { plan: { open: true, qr: false, qrIfOpenFails: false, why: 't' } });
    expect(await r.run(RID)).toBe(0);
    const link = `https://app.align.test/share/approve/${RID}#k=${KEY}`;
    expect(r.out.join('\n')).toContain(`Approve in your browser: ${link}`);
    expect(r.out.join('\n')).toContain('Code: KJ4M-9XQT');
    expect(r.opened).toEqual([link]);
    expect(r.gw.completes).toEqual([]); expect(r.gw.cancels).toEqual([]);
    expect(loadRequest(RID)).not.toBeNull();       // still there: the agent's status call finishes it
  });
  it('with a QR plan it prints the QR instead of opening', async () => {
    saveRequest(rec());
    const r = rig({ states: ['pending'] }, { plan: { open: false, qr: true, qrIfOpenFails: true, why: 't' } });
    expect(await r.run(RID)).toBe(0);
    expect(r.opened).toEqual([]); expect(r.out).toContain('QRLINE');
  });
  it('refuses an id this machine never staged, and a malformed one, without calling the gateway', async () => {
    const r = rig();
    expect(await r.run(RID)).toBe(1);
    expect(r.err.join('\n')).toMatch(/only be re-opened on the machine that staged it/);
    expect(await r.run('../../etc/passwd')).toBe(1);
    expect(r.gw.gets).toBe(0);
    expect(r.all()).not.toContain(KEY);
  });
  it('refuses another environment, another gateway, another workspace and an expired request, and prints no key', async () => {
    for (const [o, env] of [[{ envName: 'preview' }, 'prod'], [{ gatewayUrl: 'https://api.other.test' }, 'prod'], [{ tenantId: 'T2' }, 'prod'], [{ expiresAt: new Date(Date.now() - 1000).toISOString() }, 'prod']] as const) {
      saveRequest(rec(o));
      const r = rig();
      expect(await r.run(RID, env), JSON.stringify(o)).toBe(1);
      expect(r.all()).not.toContain(KEY);
      expect(r.opened).toEqual([]);
    }
  });
  it('refuses when the gateway no longer holds it pending, and when the gateway cannot be asked', async () => {
    saveRequest(rec());
    const a = rig({ states: ['approved'] });
    expect(await a.run(RID)).toBe(1); expect(a.err.join('\n')).toMatch(/approved/); expect(a.all()).not.toContain(KEY);
    const b = rig({ states: ['pending'] }); b.gw.getError = () => new Error('boom');
    expect(await b.run(RID)).toBe(1); expect(b.all()).not.toContain(KEY);
  });
  it('needs a team login like every other share path', async () => {
    saveRequest(rec());
    const r = rig({ states: ['pending'] }, { cloudEnv: { mode: 'local-embedded', gatewayUrl: 'https://api.align.test' } as never });
    expect(await r.run(RID)).toBe(1); expect(r.all()).not.toContain(KEY);
  });
});
