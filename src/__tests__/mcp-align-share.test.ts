import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { dispatchTool, TOOL_SCHEMAS, toolSchemasFor } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { runShare, type ShareDeps } from '../lib/share/command.js';
import { runShareTool, SHARE_TOOL } from '../lib/mcp/share-tool.js';
import { lookupCode } from '../lib/share/pending.js';
import { BOOK_CALL_URL } from '../lib/team-cta.js';

/**
 * L9 Test List, align_share (step one only):
 * - Returns the exact preview and `align share --confirm <code>`; a pending code exists; the share endpoint is never called (only whoami).
 * - A second call for the same decision issues a new code and the old one stops working.
 * - A `token` (or any other) property is refused by the closed schema, its value is not echoed, nothing is prepared.
 * - No team login: no code, `align login` and the team CTA. A secret in the text: no code, the placeholder named.
 * - A hosted or frozen server refuses; the tool is not listed on a hosted server.
 * - NEGATIVE: every registered tool, called with every action and with the share tool's own arguments, never calls shareBatch.
 * - The only thing that completes it is `align share --confirm` (runShare), which needs the controlling terminal.
 */
let dir: string; let dbPath: string; let env: EnvironmentConfig; let id: string;
const calls = { whoami: 0, shareBatch: 0, archive: 0 };
const client = {
  whoami: async () => { calls.whoami++; return { user: { email: 'me@co.com' }, tenant: { id: 'T1', name: 'Acme' } }; },
  shareBatch: async () => { calls.shareBatch++; return { snapshots: [{ id: 'R0', request_index: 0 }] }; },
  getDecision: async () => ({}), archiveDecision: async () => { calls.archive++; },
};
const cloud = { mode: 'auth', gatewayUrl: 'https://x', authToken: 't', tenantId: 'T1' } as EnvironmentConfig;
const ctx = (over: Record<string, unknown> = {}) => ({ clientInfo: { name: 'claude-code' }, judge: async () => ({ judgeId: 'i', judgeLabel: null }), share: { cloudEnv: cloud, envName: 'prod', client }, ...over });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-share-mcp-'));
  vi.stubEnv('XDG_STATE_HOME', path.join(dir, 'state')); fs.mkdirSync(path.join(dir, 'state'));
  dbPath = path.join(dir, 'g.db');
  const db = createLocalDb(dbPath);
  id = db.insertDecision({ title: 'Use sqlite', summary: 'because node', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github' });
  db.markRatified(id, 'me@co.com'); db.close();
  env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath } as EnvironmentConfig;
  calls.whoami = calls.shareBatch = calls.archive = 0;
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('align_share', () => {
  it('previews, issues a code, and sends nothing', async () => {
    const r = await runShareTool({ id }, env, ctx());
    expect(r.text).toContain('To: Acme (prod) as me@co.com');
    expect(r.text).toContain('Use sqlite');
    expect(r.text).toContain(`align share --confirm ${r.code}`);
    expect(r.text).toContain('NOTHING HAS BEEN SENT');
    expect(lookupCode(r.code as string).ok).toBe(true);
    expect(calls.shareBatch).toBe(0);
  });
  it('a second call issues a new code and the old one is invalidated', async () => {
    const a = await runShareTool({ id }, env, ctx());
    const b = await runShareTool({ id }, env, ctx());
    expect(b.code).not.toBe(a.code);
    expect(lookupCode(a.code as string)).toEqual({ ok: false, reason: 'unknown' });
    expect(lookupCode(b.code as string).ok).toBe(true);
  });
  it('records which agent asked', async () => {
    const r = await runShareTool({ id }, env, ctx());
    expect(lookupCode(r.code as string)).toMatchObject({ ok: true, pending: { agentId: 'claude-code' } });
  });
  it('refuses a token property by name without echoing its value, and prepares nothing', async () => {
    await expect(runShareTool({ id, token: 'sk-SECRETVALUE' }, env, ctx())).rejects.toThrow(/does not accept "token"/);
    await expect(runShareTool({ id, token: 'sk-SECRETVALUE' }, env, ctx())).rejects.not.toThrow(/SECRETVALUE/);
    await expect(runShareTool({ id, yes: 'true' }, env, ctx())).rejects.toThrow(/does not accept/);
    expect(calls.whoami).toBe(0);
  });
  it('with no team login: no code, align login and the team CTA', async () => {
    const r = await runShareTool({ id }, env, ctx({ share: { cloudEnv: { ...cloud, authToken: null }, envName: 'prod', client } }));
    expect(r.code).toBeUndefined();
    expect(r.text).toContain('align login'); expect(r.text).toContain(BOOK_CALL_URL);
    expect(calls.whoami).toBe(0);
  });
  it('a secret in the text: no code, the placeholder named', async () => {
    const db = createLocalDb(dbPath);
    const bad = db.insertDecision({ title: 'k', summary: `ghp_${'x'.repeat(36)}`, sourceUrl: 'https://github.com/o/r/pull/2', platform: 'github' });
    db.markRatified(bad, 'me@co.com'); db.close();
    const r = await runShareTool({ id: bad }, env, ctx());
    expect(r.code).toBeUndefined(); expect(r.text).toContain('<GITHUB_TOKEN>'); expect(r.text).not.toContain('xxxxxxxx');
  });
  it('an unratified decision is an error naming align ratify; a hosted server refuses', async () => {
    const db = createLocalDb(dbPath); const u = db.insertDecision({ title: 'u', summary: 's', sourceUrl: 'https://github.com/o/r/pull/3', platform: 'github' }); db.close();
    await expect(runShareTool({ id: u }, env, ctx())).rejects.toThrow(/align ratify/);
    await expect(runShareTool({ id }, { mode: 'auth', gatewayUrl: 'https://x', authToken: 't', tenantId: 'T' } as EnvironmentConfig, ctx())).rejects.toThrow(/local graph/);
  });
  it('is listed on the local server only, and a frozen server refuses', async () => {
    expect(toolSchemasFor(env).map((t) => t.name)).toContain(SHARE_TOOL);
    expect(toolSchemasFor({ mode: 'auth', gatewayUrl: 'https://x', authToken: 't', tenantId: 'T' } as EnvironmentConfig).map((t) => t.name)).not.toContain(SHARE_TOOL);
    await expect(dispatchTool(SHARE_TOOL, { id }, {} as never, env, '2026-01-01T00:00:00.000Z')).rejects.toThrow(/frozen/);
  });
});

describe('no sequence of tool calls sends a share', () => {
  it('every registered tool, with every action and with share-shaped arguments, never calls shareBatch', async () => {
    const argSets: Array<Record<string, unknown>> = [{}, { id }, { id, confirm: true }, { decision_id: id, input: 'x', diff: 'd', question: 'q', content: 'c' }];
    for (const tool of TOOL_SCHEMAS) {
      const props = ((tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {});
      const actions = props['action']?.enum ?? [undefined];
      for (const action of actions) {
        for (const base of argSets) {
          const args = action === undefined ? base : { ...base, action };
          await dispatchTool(tool.name, args, { shareBatch: async () => { calls.shareBatch++; return {}; } } as never, env, undefined, ctx() as never).catch(() => undefined);
        }
      }
    }
    expect(calls.shareBatch).toBe(0);
  }, 60_000);
  it('the positive control: the human path through runShare does call it', async () => {
    const r = await runShareTool({ id }, env, ctx());
    const out: string[] = [];
    const deps: ShareDeps = { cloudEnv: cloud, salt: 'salt-1', defaultGatewayUrl: 'https://x', localDbPath: dbPath, client: () => client, judge: async () => ({ judgeId: 'i', judgeLabel: null }), owner: async () => 'me@co.com', ttyConfirm: async () => true, out: (l) => out.push(l), err: (l) => out.push(l) };
    const code = await runShare({ ids: [], envName: 'prod', confirm: r.code as string }, deps);
    expect(out.join('\n')).toBe('');
    expect(code).toBe(0);
    expect(calls.shareBatch).toBe(1);
  });
});
