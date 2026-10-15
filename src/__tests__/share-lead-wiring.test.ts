import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { dispatchTool } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { runShare, type ShareDeps } from '../lib/share/command.js';
import { runShareTool } from '../lib/mcp/share-tool.js';
import { runShareStatusTool } from '../lib/mcp/share-status-tool.js';
import { approvalDeps, noShareRequests } from './helpers/share-requests-fake.js';

/**
 * Where the lead prompt runs:
 * - `align share` with no team login (and the local graph or not): the prompt hook runs once, after the upgrade line, and the exit stays 1.
 * - `align share` WITH a login, in demo mode, or on any later refusal: never.
 * - align_share and align_share_status (MCP) with and without a login: never, and their text never asks for an email.
 */
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });
let dir: string; let dbPath: string; let id: string; let calls: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lead-wire-'));
  vi.stubEnv('XDG_STATE_HOME', path.join(dir, 'state')); fs.mkdirSync(path.join(dir, 'state'));
  dbPath = path.join(dir, 'g.db');
  const db = createLocalDb(dbPath);
  id = db.insertDecision({ title: 'Use sqlite', summary: 'because node', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github' });
  db.markRatified(id, 'me@co.com'); db.close();
  calls = 0;
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const deps = (cloudEnv: Partial<EnvironmentConfig>, over: Partial<ShareDeps> = {}): ShareDeps & { lines: string[] } => {
  const lines: string[] = [];
  return {
    cloudEnv: { mode: 'auth', gatewayUrl: 'https://x', authToken: 't', tenantId: 'T1', ...cloudEnv } as EnvironmentConfig,
    salt: 's', defaultGatewayUrl: 'https://x', localDbPath: dbPath,
    client: () => ({ ...noShareRequests, whoami: async () => ({ user: { email: 'me@co.com' }, tenant: { id: 'T1', name: 'Acme' } }), shareBatch: async () => ({ snapshots: [] }), getDecision: async () => ({}), archiveDecision: async () => undefined }),
    judge: async () => ({ judgeId: 'i', judgeLabel: null }), owner: async () => 'me@co.com', wrapped: false, approval: approvalDeps,
    ttyConfirm: async () => false, out: (l) => lines.push(l), err: (l) => lines.push(l), leadPrompt: async () => { calls++; },
    lines, ...over,
  } as ShareDeps & { lines: string[] };
};

describe('align share', () => {
  it('no team login: prints the upgrade line, then runs the prompt once, and still exits 1', async () => {
    const d = deps({ mode: 'local-embedded', authToken: null });
    expect(await runShare({ ids: [id], envName: 'prod' }, d)).toBe(1);
    expect(calls).toBe(1);
    const cta = d.lines.findIndex((l) => l.includes('Book a 30-minute call'));
    expect(cta).toBeGreaterThanOrEqual(0);
  });
  it('an auth-mode environment with no token is also the no-login case', async () => {
    expect(await runShare({ ids: [id], envName: 'prod' }, deps({ mode: 'auth', authToken: null }))).toBe(1);
    expect(calls).toBe(1);
  });
  it('the prompt runs after the CTA is shown, never before', async () => {
    const order: string[] = [];
    const d = deps({ mode: 'local-embedded', authToken: null }, { err: (l) => order.push(l.includes('Book a') ? 'cta' : 'err'), leadPrompt: async () => { order.push('prompt'); } });
    await runShare({ ids: [id], envName: 'prod' }, d);
    expect(order).toEqual(['cta', 'prompt']);
  });
  it('with a team login: never', async () => {
    await runShare({ ids: [id], envName: 'prod' }, deps({}));
    expect(calls).toBe(0);
  });
  it('demo mode, a missing graph and a retract with a login: never', async () => {
    await runShare({ ids: [id], envName: 'prod' }, deps({ mode: 'demo' }));
    await runShare({ ids: [id], envName: 'prod' }, deps({}, { localDbPath: null }));
    await runShare({ ids: [], envName: 'prod', retract: id }, deps({}));
    expect(calls).toBe(0);
  });
  it('a prompt that throws cannot change the exit code the person sees', async () => {
    const d = deps({ mode: 'local-embedded', authToken: null }, { leadPrompt: async () => { throw new Error('boom'); } });
    await expect(runShare({ ids: [id], envName: 'prod' }, d)).resolves.toBe(1);
  });
});

describe('the MCP tools never reach the prompt', () => {
  const env = (): EnvironmentConfig => ({ mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath } as EnvironmentConfig);
  const client = { ...noShareRequests, whoami: async () => ({ user: { email: 'me@co.com' }, tenant: { id: 'T1', name: 'Acme' } }), shareBatch: async () => ({ snapshots: [] }), getDecision: async () => ({}), archiveDecision: async () => undefined };
  const share = (authToken: string | null) => ({ clientInfo: { name: 'claude-code' }, judge: async () => ({ judgeId: 'i', judgeLabel: null }), share: { cloudEnv: { mode: 'auth', gatewayUrl: 'https://x', authToken, tenantId: 'T1' } as EnvironmentConfig, envName: 'prod', client, salt: 's' } });

  it('align_share with no login: the CTA text, no email request, no prompt', async () => {
    const r = await runShareTool({ id }, env(), share(null));
    expect(r.text).toContain('align login');
    expect(r.text).not.toMatch(/e-?mail/i);
  });
  it('align_share and align_share_status with a login never ask for an email either', async () => {
    const a = await runShareTool({ id }, env(), share('t'));
    expect(a.text).not.toMatch(/e-?mail address|your email|work email/i);
    const b = await runShareStatusTool({ request_id: 'does-not-exist' }, env(), share('t')).catch((e: Error) => ({ text: e.message }));
    expect(b.text).not.toMatch(/work email|your email|confirmation email/i);
  });
  it('dispatching either tool through the MCP server never opens a terminal or posts a lead', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await dispatchTool('align_share', { id }, env(), share(null) as never).catch(() => undefined);
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/leads/'))).toEqual([]);
    fetchSpy.mockRestore();
  });
  it('the MCP tool modules do not import the prompt at all (an agent must not collect an email for a person)', () => {
    const root = path.join(__dirname, '..');
    const files = [...fs.readdirSync(path.join(root, 'lib/mcp')).map((f) => path.join(root, 'lib/mcp', f)), path.join(root, 'commands/mcp.ts')];
    expect(files.length).toBeGreaterThan(3); // positive control: the sweep found the MCP sources
    for (const f of files.filter((p) => p.endsWith('.ts'))) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/lead-prompt|ttyAsk|maybeAskLead/);
    }
  });
});
