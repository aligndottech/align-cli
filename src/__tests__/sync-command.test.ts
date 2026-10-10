import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FetcherAuthError } from '@aligndottech/connector-core';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { runSyncCommand, type SyncCommandDeps, type SyncCommandOptions } from '../commands/sync.js';
import { acquireLock } from '../lib/sync/lock.js';
import { readRows } from '../lib/sync/sync-state.js';
import { type Harness, harness, pr } from './helpers/sync-env.js';

/**
 * L5 Test List (the `align sync` command):
 * - Given a bad source, --max or --delay: exit 2 naming the fix, before anything runs.
 * - Given no local graph: says so, exit 0. Given --status: the status text.
 * - Given a held lock with a live pid, a second sync exits 0 with "already syncing".
 * - Given a 401 in sync (foreground): exit 1, status needs_reauth, the saved token is STILL in the config; in the background: exit 0 and silent.
 * - Background: waits the delay (20 s by default, none with --delay 0), prints nothing; Teams is read only when named.
 * - --classify: estimate first ("up to 30 LLM calls"), a default-No confirm, 0 calls on No / no TTY without --yes; --yes goes ahead; no provider names `align ai`.
 */
vi.setConfig({ testTimeout: 60_000 });
let h: Harness;
let out: string[];
let err: string[];
let sleeps: number[];
let tokens: Map<string, Record<string, string>>;
let refreshes: number;
let bgOff: boolean;
let bgWrites: boolean[];
beforeEach(() => {
  h = harness();
  out = []; err = []; sleeps = []; refreshes = 0; bgOff = false; bgWrites = [];
  tokens = new Map([['github', { token: 'tok' }], ['jira', { token: 'tok', domain: 'x.atlassian.net' }]]);
});
afterEach(() => h.cleanup());

function deps(over: Partial<SyncCommandDeps> = {}): SyncCommandDeps {
  return {
    out: (l) => out.push(l), err: (l) => err.push(l),
    graphPath: () => h.dbPath,
    // The command closes the client it was given; the harness client outlives one command, so give it a view without `close`.
    env: () => ({ ...h.env, tokens: (s) => tokens.get(s) ?? null, client: { ingestBatch: h.env.client.ingestBatch, relinkUnfinished: h.env.client.relinkUnfinished } }),
    statusDeps: () => ({ dbPath: h.dbPath, isConnected: (id) => tokens.has(id), syncRunning: () => false, backfill: () => null, backfillAlive: () => false }),
    isConnected: (id) => tokens.has(id),
    isTty: () => true,
    confirm: async () => false,
    sleep: async (ms) => { sleeps.push(ms); },
    refresh: () => { refreshes += 1; },
    estimate: () => ({ items: 10, calls: 30, available: 40, provider: 'Anthropic' }),
    classify: vi.fn(async () => ({ items: 10, calls: 30, typed: 12, unparsed: 0 })),
    classifyLock: () => acquireLock('sync-classify', { dir: h.lockDir, alive: () => true }),
    backgroundOff: () => bgOff,
    shellGate: () => undefined,
    setBackgroundOff: (off) => { bgOff = off; bgWrites.push(off); },
    ...over,
  };
}
const run = (sources: string[], opts: SyncCommandOptions = {}, over: Partial<SyncCommandDeps> = {}) => runSyncCommand(sources, opts, deps(over));

describe('arguments', () => {
  it('an unknown source exits 2 and names the accepted ones, truncated (a pasted secret is not echoed whole)', async () => {
    expect(await run(['myspace'])).toBe(2);
    expect(err.join('\n')).toContain('Sources: github, jira');
    out.length = 0; err.length = 0;
    expect(await run(['ghp_0123456789abcdefghijklmnop'])).toBe(2);
    expect(err.join('\n')).not.toContain('klmnop');
  });
  it('--max and --delay must be whole numbers (two bad values each)', async () => {
    expect(await run([], { classify: true, max: '0' })).toBe(2);
    expect(await run([], { classify: true, max: 'ten' })).toBe(2);
    expect(await run([], { background: true, delay: '-1' })).toBe(2);
    expect(await run([], { background: true, delay: '1.5' })).toBe(2);
    expect(h.fetchCalls).toHaveLength(0);
  });
});

describe('--off and --on (the background refresh switch)', () => {
  it('--off stores the switch, says how to turn it back on, and needs no graph and runs no sync', async () => {
    expect(await run([], { off: true }, { graphPath: () => undefined })).toBe(0);
    expect(bgWrites).toEqual([true]);
    expect(out.join('\n')).toContain('align sync --on');
    expect(h.fetchCalls).toHaveLength(0);
  });
  it('--on clears it and names the way to turn it off', async () => {
    bgOff = true;
    expect(await run([], { on: true }, { graphPath: () => undefined })).toBe(0);
    expect(bgWrites).toEqual([false]);
    expect(out.join('\n')).toContain('align sync --off');
  });
  it('--off with --on, or with a source or another mode, exits 2 and changes nothing (three examples)', async () => {
    expect(await run([], { off: true, on: true })).toBe(2);
    expect(await run(['github'], { off: true })).toBe(2);
    expect(await run([], { on: true, classify: true })).toBe(2);
    expect(bgWrites).toEqual([]);
    expect(err.join('\n')).toContain('--off');
  });
  it('--status says which way the switch is set (two examples)', async () => {
    await run([], { status: true });
    expect(out.join('\n')).toContain('Background refresh: on');
    out.length = 0; bgOff = true;
    await run([], { status: true });
    expect(out.join('\n')).toContain('Background refresh: off');
    expect(out.join('\n')).toContain('align sync --on');
  });
});

describe('no graph and --status', () => {
  it('no local graph: says so and exits 0', async () => {
    expect(await run([], {}, { graphPath: () => undefined })).toBe(0);
    expect(out.join('\n')).toContain('no local graph');
  });
  it('--status prints the status text and runs nothing', async () => {
    expect(await run([], { status: true })).toBe(0);
    expect(out.join('\n')).toContain('GitHub (your own items): not synced yet.');
    expect(h.fetchCalls).toHaveLength(0);
  });
});

describe('running', () => {
  it('syncs every connected source except Teams, refreshes the launch summary, and prints a line each', async () => {
    tokens.set('teams', { token: 'x' });
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z')] });
    expect(await run([])).toBe(0);
    expect(h.fetchCalls.map((c) => c.source)).toEqual(['github', 'jira']);
    expect(out.some((l) => l.startsWith('GitHub: 1 read'))).toBe(true);
    expect(out).toContain('Teams: refresh manually with `align connect teams` (its token lasts about an hour). Only yours until then.');
    expect(refreshes).toBe(1);
  });

  it('a source named on the command line is read even if it is Teams', async () => {
    tokens.set('teams', { token: 'x' });
    h.script({ items: [] });
    await run(['teams']);
    expect(h.fetchCalls.map((c) => c.source)).toEqual(['teams']);
  });

  it('a held lock with a live pid: "already syncing" and exit 0', async () => {
    acquireLock('sync-github', { dir: h.lockDir, pid: 4242, alive: () => true });
    h.script({ items: [] });
    expect(await run(['github'])).toBe(0);
    expect(out.join('\n')).toContain('already syncing');
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('a dead holder\'s lock is taken over and the sync runs', async () => {
    const dead = harness({}, { alive: () => false });
    try {
      acquireLock('sync-github', { dir: dead.lockDir, pid: 4242, alive: () => true });
      dead.script({ items: [] });
      expect(await runSyncCommand(['github'], {}, { ...deps(), env: () => ({ ...dead.env, client: { ingestBatch: dead.env.client.ingestBatch, relinkUnfinished: dead.env.client.relinkUnfinished } }), graphPath: () => dead.dbPath })).toBe(0);
      expect(dead.fetchCalls).toHaveLength(1);
    } finally { dead.cleanup(); }
  });

  it('a nothing-connected run says how to connect', async () => {
    tokens.clear();
    expect(await run([])).toBe(0);
    expect(out.join('\n')).toContain('No source is connected to sync. Run: align connect <source>');
  });
});

describe('a refused token', () => {
  it('foreground: exit 1, needs_reauth recorded, and the saved token is still in the config', async () => {
    h.script(new FetcherAuthError('GitHub'));
    expect(await run(['github'])).toBe(1);
    expect(readRows(h.dbPath, 'github')[0]!.status).toBe('needs_reauth');
    expect(tokens.get('github')).toEqual({ token: 'tok' });
    expect(out.join('\n')).toContain('align connect github');
  });

  it('background: exit 0, nothing printed, still recorded', async () => {
    h.script(new FetcherAuthError('GitHub'));
    expect(await run(['github'], { background: true, delay: '0' })).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(readRows(h.dbPath, 'github')[0]!.status).toBe('needs_reauth');
    expect(tokens.get('github')).toEqual({ token: 'tok' });
  });
});

describe('background: ids, the switch and the interval', () => {
  it('an id that is not a source is skipped and the rest run (a foreground run still exits 2)', async () => {
    h.script({ items: [] });
    expect(await run(['myspace', 'github'], { background: true, delay: '0' })).toBe(0);
    expect(h.fetchCalls.map((c) => c.source)).toEqual(['github']);
    expect(await run(['myspace', 'github'], {})).toBe(2);
  });
  it('only unknown ids: nothing runs, and it does not fall back to every connected source', async () => {
    expect(await run(['myspace'], { background: true, delay: '0' })).toBe(0);
    expect(h.fetchCalls).toHaveLength(0);
  });
  it('a launcher child that slept through `align sync --off` stops; an on-demand one (no delay) ignores the switch', async () => {
    bgOff = true;
    h.script({ items: [] });
    expect(await run(['github'], { background: true, delay: '20' })).toBe(0);
    expect(h.fetchCalls).toHaveLength(0);
    expect(await run(['github'], { background: true, delay: '0' })).toBe(0);
    expect(h.fetchCalls).toHaveLength(1);
  });
  it('--off with --yes, --max or --delay exits 2 and changes nothing', async () => {
    for (const o of [{ off: true, yes: true }, { off: true, max: '5' }, { on: true, delay: '3' }] as SyncCommandOptions[]) expect(await run([], o)).toBe(2);
    expect(bgWrites).toEqual([]);
  });
  it('--status says off in this shell when ALIGN_NO_SYNC or CI applies, and the switch itself wins when it is off', async () => {
    await run([], { status: true }, { shellGate: () => 'ALIGN_NO_SYNC is set' });
    expect(out.join('\n')).toContain('off in this shell (ALIGN_NO_SYNC is set)');
    out.length = 0; bgOff = true;
    await run([], { status: true }, { shellGate: () => 'this looks like CI' });
    expect(out.join('\n')).toContain('Background refresh: off. Turn it on');
  });
  it('--off explains what it does not stop', async () => {
    await run([], { off: true, on: true });
    expect(err.join('\n')).toContain('align_backfill');
  });
});

describe('background', () => {
  it('waits 20 seconds by default before the first request, and 0 when told', async () => {
    h.script({ items: [] });
    await run(['github'], { background: true });
    expect(sleeps).toEqual([20_000]);
    sleeps.length = 0;
    await run(['github'], { background: true, delay: '0' });
    expect(sleeps).toEqual([]);
    await run(['github'], { background: true, delay: '5' });
    expect(sleeps).toEqual([5_000]);
  });

  it('never touches Teams, even when it is the only connected source, and prints no hint', async () => {
    tokens.clear();
    tokens.set('teams', { token: 'x' });
    expect(await run([], { background: true, delay: '0' })).toBe(0);
    expect(h.fetchCalls).toHaveLength(0);
    expect(out).toEqual([]);
  });

  it('an error in one source does not turn a background exit non-zero', async () => {
    h.script(new Error('socket hang up'));
    expect(await run(['github'], { background: true, delay: '0' })).toBe(0);
  });
});

describe('--classify', () => {
  const calls = (d: SyncCommandDeps) => (d.classify as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

  it('prints the estimate first, asks (default No), and with No makes 0 calls', async () => {
    const d = deps();
    const confirm = vi.fn(async () => false);
    expect(await runSyncCommand([], { classify: true, max: '10' }, { ...d, confirm })).toBe(0);
    expect(out[0]).toBe('This classifies 10 of 40 items, using up to 30 LLM calls on your Anthropic key.');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls(d)).toBe(0);
    expect(out.join('\n')).toContain('Nothing was sent.');
  });

  it('with Yes it classifies exactly the estimated items and reports the cost it incurred', async () => {
    const d = deps();
    expect(await runSyncCommand([], { classify: true, max: '10' }, { ...d, confirm: async () => true })).toBe(0);
    expect(d.classify).toHaveBeenCalledWith(h.dbPath, 10);
    expect(out.join('\n')).toContain('Classified 10 items with 30 LLM calls: 12 relationships typed.');
  });

  it('no terminal and no --yes: refuses, names --yes, 0 calls; with --yes it goes ahead', async () => {
    const d = deps({ isTty: () => false });
    expect(await runSyncCommand([], { classify: true }, d)).toBe(1);
    expect(err.join('\n')).toContain('--yes');
    expect(calls(d)).toBe(0);
    expect(await runSyncCommand([], { classify: true, yes: true }, d)).toBe(0);
    expect(calls(d)).toBe(1);
  });

  it('no provider: names `align ai`, 0 calls, and does not ask', async () => {
    const d = deps({ estimate: () => ({ items: 10, calls: 30, available: 40, provider: undefined }) });
    const confirm = vi.fn(async () => true);
    expect(await runSyncCommand([], { classify: true }, { ...d, confirm })).toBe(1);
    expect(err.join('\n')).toContain('align ai');
    expect(confirm).not.toHaveBeenCalled();
    expect(calls(d)).toBe(0);
  });

  it('nothing untyped: says so, no question, no calls', async () => {
    const d = deps({ estimate: () => ({ items: 0, calls: 0, available: 0, provider: 'Anthropic' }) });
    const confirm = vi.fn(async () => true);
    expect(await runSyncCommand([], { classify: true }, { ...d, confirm })).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Nothing to classify');
  });

  it('another classification holding the lock: nothing is spent', async () => {
    acquireLock('sync-classify', { dir: h.lockDir, pid: 4242, alive: () => true });
    const d = deps({ confirm: async () => true });
    expect(await runSyncCommand([], { classify: true, yes: true }, d)).toBe(0);
    expect(calls(d)).toBe(0);
    expect(out.join('\n')).toContain('already running');
  });

  it('a provider that stopped mid-run exits 1 and says the rest stays untyped', async () => {
    const d = deps({ classify: vi.fn(async () => ({ items: 2, calls: 5, typed: 3, unparsed: 0, stopped: 'the AI provider stopped answering (a bad key, no credit or a rate limit)' })) });
    expect(await runSyncCommand([], { classify: true, yes: true }, d)).toBe(1);
    expect(err.join('\n')).toContain('The rest stay untyped');
  });
});

describe('a run that dies', () => {
  const throwingLock = (d: SyncCommandDeps): SyncCommandDeps => ({ ...d, env: (p) => ({ ...d.env(p), lock: () => { throw new Error('EACCES: cannot create the lock'); } }) });

  it('in the background: exit 0, the summary is still refreshed, and the reason is recorded on the source for the next foreground moment', async () => {
    const code = await runSyncCommand(['github'], { background: true, delay: '0' }, throwingLock(deps()));
    expect(code).toBe(0);
    expect(refreshes).toBe(1);
    expect(out).toEqual([]);
    const row = readRows(h.dbPath, 'github')[0]!;
    expect(row.status).toBe('error');
    expect(JSON.parse(row.skips_last_run!)[0]).toMatchObject({ kind: 'error', detail: 'EACCES: cannot create the lock' });
    expect(tokens.get('github')).toEqual({ token: 'tok' });
  });

  it('a re-link failure in the background is recorded too (the sources before it already synced)', async () => {
    h.script({ items: [] });
    const d = deps();
    const failing: SyncCommandDeps = { ...d, env: (p) => ({ ...d.env(p), client: { ingestBatch: h.env.client.ingestBatch, relinkUnfinished: async () => { throw new Error('disk full'); } } }) };
    const db = new DatabaseSync(h.dbPath);
    db.exec(`INSERT INTO decisions (id, title, summary, platform, source_url) VALUES ('x', 'x', 's', 'github', 'https://github.com/o/r/pull/5')`);
    db.close();
    expect(await runSyncCommand(['github'], { background: true, delay: '0' }, failing)).toBe(0);
    expect(JSON.parse(readRows(h.dbPath, 'github')[0]!.skips_last_run!)[0].detail).toContain('finishing links failed: disk full');
  });

  it('in the foreground it still throws (the fatal handler prints it), and the summary is refreshed first', async () => {
    await expect(runSyncCommand(['github'], {}, throwingLock(deps()))).rejects.toThrow('EACCES');
    expect(refreshes).toBe(1);
  });

  it('a foreground re-link failure is printed, not thrown', async () => {
    h.script({ items: [] });
    const d = deps();
    const failing: SyncCommandDeps = { ...d, env: (p) => ({ ...d.env(p), client: { ingestBatch: h.env.client.ingestBatch, relinkUnfinished: async () => { throw new Error('disk full'); } } }) };
    const db = new DatabaseSync(h.dbPath);
    db.exec(`INSERT INTO decisions (id, title, summary, platform, source_url) VALUES ('x', 'x', 's', 'github', 'https://github.com/o/r/pull/5')`);
    db.close();
    expect(await runSyncCommand(['github'], {}, failing)).toBe(0);
    expect(err.join('\n')).toContain('finishing the links failed: disk full');
  });
});
