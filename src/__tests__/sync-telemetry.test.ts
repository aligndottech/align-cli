/**
 * L7: which sync outcomes become a `source_synced` ping, and what the sync command hands the
 * reporter. Counts and closed enums only; a state that synced nothing (locked, not connected,
 * backfill running, Teams by hand) is not a sync and sends nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { syncMeasurementOf } from '../lib/sync/telemetry.js';
import type { SourceOutcome } from '../lib/sync/run-source.js';
import { runSyncCommand, type SyncCommandDeps } from '../commands/sync.js';

const outcome = (over: Partial<SourceOutcome> = {}): SourceOutcome => ({
  source: 'github', state: 'ok', read: 50, created: 30, updated: 12, skips: [], scope: 'yours', ...over,
});

describe('syncMeasurementOf', () => {
  it('a completed github sync: count is created plus updated, enums are the closed values', () => {
    expect(syncMeasurementOf(outcome(), 'background')).toEqual({ count: 42, source: 'github', outcome: 'ok', scope: 'yours', trigger: 'background' });
  });
  it('a second example: a partial team-scope jira sync run by hand', () => {
    expect(syncMeasurementOf(outcome({ source: 'jira', state: 'partial', created: 2, updated: 0, scope: 'team' }), 'manual'))
      .toEqual({ count: 2, source: 'jira', outcome: 'partial', scope: 'team', trigger: 'manual' });
  });
  it.each(['needs_reauth', 'error'] as const)('a %s outcome is reported (a refused token is the funnel signal)', (state) => {
    expect(syncMeasurementOf(outcome({ state, created: 0, updated: 0 }), 'manual')?.outcome).toBe(state);
  });
  it.each(['locked', 'backfill_running', 'not_connected', 'manual'] as const)('%s synced nothing and reports nothing', (state) => {
    expect(syncMeasurementOf(outcome({ state }), 'manual')).toBeUndefined();
  });
  it('an outcome with no scope reports nothing rather than guessing one', () => {
    const { scope: _scope, ...noScope } = outcome();
    expect(syncMeasurementOf(noScope, 'manual')).toBeUndefined();
  });
  it('carries nothing from the outcome beyond the five fields (a canary in message, scopeNote, skips)', () => {
    const m = syncMeasurementOf(outcome({
      message: 'CANARY-title', scopeNote: 'CANARY-repo acme/secret', since: 'CANARY', reachedBack: 'CANARY',
      skips: [{ kind: 'error', count: 1, detail: 'CANARY-url https://example.com/x' }],
    }), 'manual');
    expect(Object.keys(m!).sort()).toEqual(['count', 'outcome', 'scope', 'source', 'trigger']);
    expect(JSON.stringify(m)).not.toContain('CANARY');
  });
});

describe('the sync command reports each source', () => {
  function deps(report: SyncCommandDeps['report'], outcomes: SourceOutcome[]): SyncCommandDeps {
    return {
      out: () => {}, err: () => {}, graphPath: () => '/tmp/none.db',
      env: () => ({ client: {} } as never),
      statusDeps: () => ({} as never), isConnected: () => true, isTty: () => true, confirm: async () => false,
      sleep: async () => {}, refresh: () => {}, estimate: vi.fn(), classify: vi.fn(), classifyLock: vi.fn(),
      report, run: async (_t, _e, o) => { for (const x of outcomes) o.onOutcome?.(x); return { outcomes }; },
    } as unknown as SyncCommandDeps;
  }
  it('a foreground sync reports trigger manual, one call per outcome', async () => {
    const report = vi.fn(async () => {});
    await runSyncCommand(['github'], {}, deps(report, [outcome()]));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ source: 'github' }), 'manual');
  });
  it('the background child reports trigger background', async () => {
    const report = vi.fn(async () => {});
    await runSyncCommand(['github'], { background: true, delay: '0' }, deps(report, [outcome()]));
    expect(report).toHaveBeenCalledWith(expect.anything(), 'background');
  });
  it('a reporter that rejects does not fail the sync', async () => {
    const report = vi.fn(async () => { throw new Error('boom'); });
    await expect(runSyncCommand(['github'], {}, deps(report, [outcome()]))).resolves.toBe(0);
  });
  it('--status and --classify report nothing', async () => {
    const report = vi.fn(async () => {});
    await runSyncCommand([], { status: true }, { ...deps(report, []), statusDeps: () => ({ dbPath: '/tmp/none.db', isConnected: () => false, syncRunning: () => false, backfill: () => null, backfillAlive: () => false }) });
    expect(report).not.toHaveBeenCalled();
  });
});

describe('the whole telemetry wait in `align sync`', () => {
  it('N sources whose pings never finish cost about 1.5 s in total, not N times a cap', async () => {
    vi.useFakeTimers();
    try {
      const outcomes = ['github', 'jira', 'gitlab', 'linear'].map((source) => outcome({ source }));
      const never = vi.fn(() => new Promise<void>(() => {}));
      const d = {
        out: () => {}, err: () => {}, graphPath: () => '/tmp/none.db', env: () => ({ client: {} } as never),
        statusDeps: () => ({} as never), isConnected: () => true, isTty: () => true, confirm: async () => false,
        sleep: async () => {}, refresh: () => {}, estimate: vi.fn(), classify: vi.fn(), classifyLock: vi.fn(),
        report: never, run: async (_t: unknown, _e: unknown, o: { onOutcome?: (x: SourceOutcome) => void }) => { for (const x of outcomes) o.onOutcome?.(x); return { outcomes }; },
      } as unknown as SyncCommandDeps;
      let done = false;
      const p = runSyncCommand(['github'], {}, d).then((c) => { done = true; return c; });
      await vi.advanceTimersByTimeAsync(1_400);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(true);
      expect(await p).toBe(0);
      expect(never).toHaveBeenCalledTimes(4); // all four started together, none waited for another
    } finally {
      vi.useRealTimers();
    }
  });
});
