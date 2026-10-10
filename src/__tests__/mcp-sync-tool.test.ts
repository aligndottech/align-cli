import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import { runSyncTool, SYNC_TOOL_SCHEMA, type SyncToolDeps } from '../lib/mcp-sync.js';
import type { SourceStatus } from '../lib/sync/status.js';

/**
 * L5 Test List (align_sync):
 * - status: per source scope, last success, status, items last run, discussion pending, skip counts; NO item content; the Teams note; the re-auth command.
 * - run: starts the detached child and returns; the lock held or a backfill running means "already syncing" and no second child; not connected / needs_reauth start nothing and give the command.
 * - classify_estimate: "up to 120 LLM calls on your <provider> key" and `align sync --classify --max 40`, 0 calls made; no provider names `align ai`.
 * - The schema is closed: a token or key is refused before anything runs, and its value is never echoed. There is no action that classifies.
 */
const localEnv = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: '/ignored/graph.db' } as EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: null } as EnvironmentConfig;

function deps(over: Partial<SyncToolDeps> = {}, connected: string[] = ['github', 'slack']): SyncToolDeps & { starts: string[][] } {
  const starts: string[][] = [];
  return {
    dbPath: '/ignored/graph.db',
    status: { dbPath: '/nonexistent/graph.db', isConnected: (id) => connected.includes(id), syncRunning: () => false, backfill: () => null, backfillAlive: () => false },
    needsReauth: () => false,
    syncRunning: () => false,
    backfillRunning: () => false,
    start: async (sources) => { starts.push(sources); return { ok: true, pid: 9 }; },
    estimate: () => ({ items: 40, calls: 120, available: 40, provider: 'Anthropic' }),
    starts,
    ...over,
  };
}

describe('schema', () => {
  it('is closed, requires action, and offers only status, run and classify_estimate', () => {
    expect(SYNC_TOOL_SCHEMA.inputSchema.additionalProperties).toBe(false);
    expect(SYNC_TOOL_SCHEMA.inputSchema.required).toEqual(['action']);
    expect(SYNC_TOOL_SCHEMA.inputSchema.properties.action.enum).toEqual(['status', 'run', 'classify_estimate']);
    expect(Object.keys(SYNC_TOOL_SCHEMA.inputSchema.properties).sort()).toEqual(['action', 'max', 'source']);
  });

  it('refuses a token or key before anything runs, naming the key and never echoing the value (two examples)', async () => {
    const d = deps();
    await expect(runSyncTool({ action: 'run', token: 'ghp_SECRETVALUE0123456789' }, localEnv, d)).rejects.toThrow(/"token"/);
    await expect(runSyncTool({ action: 'run', api_key: 'sk-ant-SECRETVALUE' }, localEnv, d)).rejects.toThrow(/"api_key"/);
    try { await runSyncTool({ action: 'run', token: 'ghp_SECRETVALUE0123456789' }, localEnv, d); } catch (e) { expect((e as Error).message).not.toContain('SECRETVALUE'); }
    expect(d.starts).toEqual([]);
  });

  it('a bad action, source or max is a tool error', async () => {
    await expect(runSyncTool({}, localEnv, deps())).rejects.toThrow(/requires "action"/);
    await expect(runSyncTool({ action: 'classify' }, localEnv, deps())).rejects.toThrow(/requires "action"/);
    await expect(runSyncTool({ action: 'run', source: 'myspace' }, localEnv, deps())).rejects.toThrow(/"source" must be one of/);
    await expect(runSyncTool({ action: 'classify_estimate', max: 0 }, localEnv, deps())).rejects.toThrow(/"max"/);
    await expect(runSyncTool({ action: 'classify_estimate', max: 1.5 }, localEnv, deps())).rejects.toThrow(/"max"/);
  });

  it('a hosted server refuses: this refreshes the local graph', async () => {
    await expect(runSyncTool({ action: 'status' }, cloudEnv, deps())).rejects.toThrow(/local graph/);
  });
});

describe('status', () => {
  it('returns connected sources only, with their facts, and text', async () => {
    const r = await runSyncTool({ action: 'status' }, localEnv, deps());
    expect((r['sources'] as SourceStatus[]).map((s) => s.id)).toEqual(['github', 'slack']);
    expect(r.text).toContain('GitHub (your own items): not synced yet.');
  });

  it('Teams carries the manual-refresh note', async () => {
    const r = await runSyncTool({ action: 'status' }, localEnv, deps({}, ['teams']));
    expect(r.text).toContain('Teams: refresh manually with `align connect teams`');
  });
});

describe('run', () => {
  it('starts one child for every connected source except Teams, and says how to watch it', async () => {
    const d = deps({}, ['github', 'slack', 'teams']);
    const r = await runSyncTool({ action: 'run' }, localEnv, d);
    expect(d.starts).toEqual([['github', 'slack']]);
    expect(r).toMatchObject({ started: true, sources: ['github', 'slack'] });
    expect(r.text).toContain('action "status"');
    expect(r.text).toContain('makes no LLM calls');
  });

  it('a named source starts only that one (second example)', async () => {
    const d = deps();
    await runSyncTool({ action: 'run', source: 'slack' }, localEnv, d);
    expect(d.starts).toEqual([['slack']]);
  });

  it('a source whose sync is running, or whose backfill is, is "already syncing": no second child', async () => {
    const d = deps({ syncRunning: (s) => s === 'github' });
    const r = await runSyncTool({ action: 'run', source: 'github' }, localEnv, d);
    expect(r).toMatchObject({ started: false });
    expect(r.text).toContain('already syncing');
    expect(d.starts).toEqual([]);
    const b = deps({ backfillRunning: () => true });
    expect((await runSyncTool({ action: 'run' }, localEnv, b)).started).toBe(false);
    expect(b.starts).toEqual([]);
  });

  it('with two sources and one busy, only the free one starts, and the busy one is named', async () => {
    const d = deps({ syncRunning: (s) => s === 'github' });
    const r = await runSyncTool({ action: 'run' }, localEnv, d);
    expect(d.starts).toEqual([['slack']]);
    expect(r.text).toContain('github is already syncing or being backfilled');
  });

  it('a source that is not connected starts nothing and gives the command', async () => {
    const d = deps();
    const r = await runSyncTool({ action: 'run', source: 'jira' }, localEnv, d);
    expect(r.started).toBe(false);
    expect(r.text).toContain('align connect jira');
    expect(d.starts).toEqual([]);
  });

  it('needs_reauth starts nothing for that source and gives the re-auth command', async () => {
    const d = deps({ needsReauth: (s) => s === 'github' });
    const r = await runSyncTool({ action: 'run', source: 'github' }, localEnv, d);
    expect(r.started).toBe(false);
    expect(r.text).toContain('align connect github');
    expect(d.starts).toEqual([]);
    const both = deps({ needsReauth: (s) => s === 'github' });
    await runSyncTool({ action: 'run' }, localEnv, both);
    expect(both.starts).toEqual([['slack']]);
  });

  it('Teams by name is manual: nothing starts', async () => {
    const d = deps({}, ['teams']);
    const r = await runSyncTool({ action: 'run', source: 'teams' }, localEnv, d);
    expect(r.started).toBe(false);
    expect(r.text).toContain('align connect teams');
    expect(d.starts).toEqual([]);
  });

  it('nothing connected: says how to connect', async () => {
    const r = await runSyncTool({ action: 'run' }, localEnv, deps({}, []));
    expect(r.text).toContain('align connect <source>');
  });

  it('a child that did not start is reported as not started, with the command to run by hand', async () => {
    const r = await runSyncTool({ action: 'run', source: 'github' }, localEnv, deps({ start: async () => ({ ok: false }) }));
    expect(r.started).toBe(false);
    expect(r.text).toContain('align sync github');
  });
});

describe('classify_estimate', () => {
  it('40 untyped items: up to 120 calls on the named provider, the command for the person, and no start', async () => {
    const d = deps();
    const r = await runSyncTool({ action: 'classify_estimate', max: 40 }, localEnv, d);
    expect(r.text).toContain('up to 120 LLM calls on your Anthropic key');
    expect(r.text).toContain('align sync --classify --max 40');
    expect(r.text).toContain('Nothing was sent');
    expect(r).toMatchObject({ max_llm_calls: 120, command: 'align sync --classify --max 40' });
    expect(d.starts).toEqual([]);
  });

  it('asks the estimator with the requested max, defaulting to 25', async () => {
    const estimate = vi.fn(() => ({ items: 25, calls: 75, available: 90, provider: 'Anthropic' }));
    await runSyncTool({ action: 'classify_estimate', max: 7 }, localEnv, deps({ estimate }));
    await runSyncTool({ action: 'classify_estimate' }, localEnv, deps({ estimate }));
    expect(estimate.mock.calls.map((c) => (c as unknown as [string, number])[1])).toEqual([7, 25]);
  });

  it('no provider: names `align ai` and gives no estimate', async () => {
    const r = await runSyncTool({ action: 'classify_estimate' }, localEnv, deps({ estimate: () => ({ items: 5, calls: 15, available: 5, provider: undefined }) }));
    expect(r.text).toContain('align ai');
    expect(r.text).not.toContain('LLM calls');
    expect(r).not.toHaveProperty('max_llm_calls');
  });

  it('nothing to classify: says so', async () => {
    const r = await runSyncTool({ action: 'classify_estimate' }, localEnv, deps({ estimate: () => ({ items: 0, calls: 0, available: 0, provider: 'Anthropic' }) }));
    expect(r.text).toContain('Nothing to classify');
  });
});
