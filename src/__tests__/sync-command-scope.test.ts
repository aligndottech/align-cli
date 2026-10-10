import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { runSyncCommand, type SyncCommandDeps } from '../commands/sync.js';
import { acquireLock } from '../lib/sync/lock.js';
import { type Harness, harness } from './helpers/sync-env.js';

vi.setConfig({ testTimeout: 60_000 });

/**
 * L4 Test List (`align sync` and the team-scope disclosure):
 * - A foreground `align sync` prints the disclosure the scope code returns, before the source's own line.
 * - A background run (`--background`) prints nothing, and does not mark the disclosure as told.
 * - Blocked Confluence is reported with its command and exits 0 (nothing failed; the person has to pick spaces).
 */
let h: Harness;
let out: string[];
let marked: string[];
beforeEach(() => { h = harness(); out = []; marked = []; });
afterEach(() => h.cleanup());

function deps(scope: Record<string, unknown>): SyncCommandDeps {
  return {
    out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`),
    graphPath: () => h.dbPath,
    env: () => ({
      ...h.env,
      tokens: () => ({ token: 'tok' }),
      scopeOf: async () => ({ scopeKey: 'jira:ALI', scope: 'team' as const, extras: { projects: ['ALI'] }, ...scope }),
      markDisclosed: (s) => { marked.push(s); },
      client: { ingestBatch: h.env.client.ingestBatch, relinkUnfinished: h.env.client.relinkUnfinished },
    }),
    statusDeps: () => ({ dbPath: h.dbPath, isConnected: () => true, syncRunning: () => false, backfill: () => null, backfillAlive: () => false }),
    isConnected: () => true,
    isTty: () => true,
    confirm: async () => false,
    sleep: async () => {},
    refresh: () => {},
    estimate: () => ({ items: 0, calls: 0, available: 0, provider: undefined }),
    classify: vi.fn(),
    classifyLock: () => acquireLock('sync-classify', { dir: h.lockDir, alive: () => true }),
    backgroundOff: () => false, setBackgroundOff: () => {}, shellGate: () => undefined, inAgent: () => false, noteOutcome: () => {}, backgroundProblems: () => [],
  };
}
const DISCLOSURE = 'Importing items from everyone in Jira project ALI that your token can read. They stay on this machine. To read only your own: align connect jira --scope yours';

describe('the disclosure in align sync', () => {
  it('a foreground run prints it before the source line, and marks it told', async () => {
    h.script({ items: [] });
    await runSyncCommand(['jira'], {}, deps({ disclosure: DISCLOSURE }));
    const at = out.indexOf(DISCLOSURE);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(out.findIndex((l) => l.startsWith('Jira:'))).toBeGreaterThan(at);
    expect(marked).toEqual(['jira']);
  });

  it('a background run prints nothing and marks nothing', async () => {
    h.script({ items: [] });
    await runSyncCommand(['jira'], { background: true, delay: '0' }, deps({ disclosure: DISCLOSURE }));
    expect(out).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('the command asks the question only at a terminal (default No): a pty-less run is never asked and never promotes', async () => {
    h.script({ items: [] });
    const asked: string[] = [];
    const base = deps({ disclosure: DISCLOSURE, activates: true });
    const ask = async (m: string): Promise<boolean> => { asked.push(m); return true; };
    const tty = { ...base, isTty: () => true, confirm: ask };
    await runSyncCommand(['jira'], {}, tty);
    expect(asked).toHaveLength(1);
    expect(marked).toEqual(['jira']);
    marked.length = 0; asked.length = 0;
    const noTty = { ...base, isTty: () => false, confirm: ask };
    await runSyncCommand(['jira'], {}, noTty);
    expect(asked).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('a terminal nobody answers: the question is No after 60 s, the source is read under what was in force, and the lock is released', async () => {
    vi.useFakeTimers();
    try {
      h.script({ items: [] });
      const never = { ...deps({ disclosure: DISCLOSURE, activates: true }), isTty: () => true, confirm: () => new Promise<boolean>(() => {}) };
      let code: number | undefined;
      const run = runSyncCommand(['jira'], {}, never).then((c) => { code = c; });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(code).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      await run;
      expect(code).toBe(0);
      expect(marked).toEqual([]);
      expect(acquireLock('sync-jira', { dir: h.lockDir, alive: () => true }).ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a foreground run with no disclosure to give prints none', async () => {
    h.script({ items: [] });
    await runSyncCommand(['jira'], {}, deps({}));
    expect(out.join('\n')).not.toContain('Importing items from everyone');
  });

  it('blocked Confluence prints the command and exits 0', async () => {
    h.script({ items: [] });
    const code = await runSyncCommand(['confluence'], {}, deps({ scopeKey: 'yours', scope: 'yours', extras: {}, blocked: 'Confluence reads only the spaces you choose. Pick them: align connect confluence --spaces ENG,OPS' }));
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('align connect confluence --spaces ENG,OPS');
    expect(h.fetchCalls).toHaveLength(0);
  });
});
