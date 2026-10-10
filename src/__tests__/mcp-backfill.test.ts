import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import type { BackfillStatus } from '../lib/backfill-state.js';
import { BACKFILL_SOURCES, BACKFILL_TOOL, backfillArgv, type BackfillDeps, runBackfill } from '../lib/mcp-backfill.js';
import { ACCEPTED_SINCE_FORMS } from '../lib/since.js';

/**
 * L3: `align_backfill({ source, since })`. A connected, healthy source gets its window recorded and
 * a detached child started (Decision 9: a tool call never runs a bulk fetch in the MCP server's
 * own process). Not connected, or waiting on re-authentication: nothing starts, and the exact
 * command for the human comes back. Never classifies, never accepts a token.
 */
const NOW = new Date('2026-10-10T12:00:00.000Z');
const localEnv = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: '/ignored/graph.db' } as EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: null } as EnvironmentConfig;

type Fake = BackfillDeps & { spawned: string[][]; recorded: Array<[string, string | null, string]>; events: string[]; running: BackfillStatus[] };
function deps(over: Partial<BackfillDeps> = {}, running: BackfillStatus[] = []): Fake {
  const spawned: string[][] = [];
  const recorded: Array<[string, string | null, string]> = [];
  const events: string[] = [];
  const fake: Fake = {
    now: () => NOW,
    isConnected: () => true,
    needsReauth: () => false,
    recordWindow: (source, since, agent) => { recorded.push([source, since, agent]); events.push('record'); },
    live: () => fake.running,
    start: async (source, argv) => {
      spawned.push(argv); events.push('start');
      fake.running = [...fake.running, { source, pid: 100 + spawned.length, started_at: NOW.toISOString(), state: 'running' }];
      return { ok: true, pid: 100 + spawned.length };
    },
    spawned,
    recorded,
    events,
    running,
    ...over,
  };
  return fake;
}
const text = (r: { text: string }) => r.text;

describe('a connected, healthy source', () => {
  it('records the window and starts one detached connect for exactly that source and window', async () => {
    const d = deps();
    const r = await runBackfill({ source: 'github', since: '1y' }, localEnv, d);
    expect(d.recorded).toEqual([['github', '2025-10-10T12:00:00.000Z', 'unknown']]);
    expect(d.spawned).toEqual([['connect', '--env', 'local', '--source', 'github', '--since', '1y', '--yes', '--json']]);
    expect(text(r)).toContain('Backfill started for github back to 2025-10-10');
    expect(r.started).toBe(true);
  });

  it('a second source and window (two examples): jira, 30d', async () => {
    const d = deps();
    const r = await runBackfill({ source: 'jira', since: '30d' }, localEnv, d);
    expect(d.recorded).toEqual([['jira', '2026-09-10T12:00:00.000Z', 'unknown']]);
    expect(d.spawned[0]).toEqual(['connect', '--env', 'local', '--source', 'jira', '--since', '30d', '--yes', '--json']);
    expect(text(r)).toContain('back to 2026-09-10');
  });

  it('no since means the plan default, six months, passed through as 180d', async () => {
    const d = deps();
    await runBackfill({ source: 'slack' }, localEnv, d);
    expect(d.recorded[0]![1]).toBe('2026-04-13T12:00:00.000Z');
    expect(d.spawned[0]).toContain('180d');
  });

  it('"all" records no lower bound and says the ceiling is the only limit', async () => {
    const d = deps();
    const r = await runBackfill({ source: 'linear', since: 'all' }, localEnv, d);
    expect(d.recorded[0]![1]).toBeNull();
    expect(d.spawned[0]).toEqual(['connect', '--env', 'local', '--source', 'linear', '--since', 'all', '--yes', '--json']);
    expect(text(r)).toMatch(/as far back as the ceiling allows/);
  });

  it('names the scope plainly: inside a repo GitHub reads everyone\'s PRs and issues in it, elsewhere only yours', async () => {
    const r = await runBackfill({ source: 'github', since: '1y' }, localEnv, deps());
    expect(text(r)).toMatch(/everyone's PRs and issues/);
  });

  it('says where the result shows up, without promising a status tool that does not exist yet', async () => {
    const r = await runBackfill({ source: 'github', since: '1y' }, localEnv, deps());
    expect(text(r)).not.toContain('align_sync');
    expect(text(r)).toMatch(/background/);
  });

  it('never puts a credential anywhere: the child argv carries no token, the text carries none', async () => {
    const d = deps();
    const r = await runBackfill({ source: 'github', since: '1y' }, localEnv, d);
    expect(JSON.stringify([d.spawned, d.recorded, r])).not.toMatch(/token|ghp_|secret/i);
  });
});

describe('the child always targets the local graph (review 1)', () => {
  it('backfillArgv puts --env local right after connect, whatever the user\'s default env is', () => {
    expect(backfillArgv('github', '1y')).toEqual(['connect', '--env', 'local', '--source', 'github', '--since', '1y', '--yes', '--json']);
    expect(backfillArgv('jira', 'all').slice(0, 3)).toEqual(['connect', '--env', 'local']);
  });

  it('every spawn carries it', async () => {
    const d = deps();
    await runBackfill({ source: 'linear', since: '2w' }, localEnv, d);
    expect(d.spawned[0]!.slice(0, 3)).toEqual(['connect', '--env', 'local']);
  });
});

describe('"started" is claimed only when the child started (review 1)', () => {
  it('a child that cannot start: says so, records no window, claims nothing', async () => {
    const d = deps({ start: async () => ({ ok: false }) });
    const r = await runBackfill({ source: 'github', since: '1y' }, localEnv, d);
    expect(r.started).toBe(false);
    expect(text(r)).toMatch(/could not start/i);
    expect(text(r)).not.toMatch(/Backfill started/);
    expect(d.recorded).toEqual([]);
  });

  it('the window is written AFTER the child started', async () => {
    const d = deps();
    await runBackfill({ source: 'github', since: '1y' }, localEnv, d);
    expect(d.events).toEqual(['start', 'record']);
  });

  it('a child that cannot start still names the command the person can run themselves', async () => {
    const r = await runBackfill({ source: 'jira', since: '30d' }, localEnv, deps({ start: async () => ({ ok: false }) }));
    expect(text(r)).toContain('align connect jira --since 30d');
  });
});

describe('at most one child per source and three in all (review 6)', () => {
  it('a second backfill of a running source says already running and starts nothing', async () => {
    const d = deps();
    await runBackfill({ source: 'github' }, localEnv, d);
    const r = await runBackfill({ source: 'github', since: '1y' }, localEnv, d);
    expect(r.started).toBe(false);
    expect(text(r)).toMatch(/already running/i);
    expect(d.spawned).toHaveLength(1);
    expect(d.recorded).toHaveLength(1); // the refused call did not rewrite the window either
  });

  it('five calls start at most three children', async () => {
    const d = deps();
    const replies = [];
    for (const source of ['github', 'github', 'jira', 'slack', 'linear']) replies.push(await runBackfill({ source }, localEnv, d));
    expect(d.spawned).toHaveLength(3);
    expect(replies.map((r) => r.started)).toEqual([true, false, true, true, false]);
    expect(text(replies[4]!)).toMatch(/already running/i);
  });

  it('a stale pid file (the child died) is not "running": the fake reports only live ones, and a new child starts', async () => {
    const d = deps({}, []); // nothing alive
    const r = await runBackfill({ source: 'github' }, localEnv, d);
    expect(r.started).toBe(true);
  });
});

describe('a bad window starts nothing', () => {
  it.each(['6x', '-3d', '', '0d'])('since %j is a tool error naming the accepted forms', async (since) => {
    const d = deps();
    await expect(runBackfill({ source: 'github', since }, localEnv, d)).rejects.toThrow(ACCEPTED_SINCE_FORMS);
    expect(d.spawned).toEqual([]);
    expect(d.recorded).toEqual([]);
  });
});

describe('a source the user has to act on starts nothing and returns the command', () => {
  it.each(['github', 'jira'])('%s not connected', async (source) => {
    const d = deps({ isConnected: () => false });
    const r = await runBackfill({ source, since: '1y' }, localEnv, d);
    expect(d.spawned).toEqual([]);
    expect(d.recorded).toEqual([]);
    expect(text(r)).toContain(`align connect ${source}`);
    expect(r.started).toBe(false);
  });

  it('needs_reauth: the same, and it says to re-authenticate', async () => {
    const d = deps({ needsReauth: () => true });
    const r = await runBackfill({ source: 'github', since: '1y' }, localEnv, d);
    expect(d.spawned).toEqual([]);
    expect(d.recorded).toEqual([]);
    expect(text(r)).toContain('align connect github');
    expect(text(r)).toMatch(/re-?authenticate/i);
  });

  it('not connected wins over a stale needs_reauth row (nothing to re-authenticate)', async () => {
    const r = await runBackfill({ source: 'github' }, localEnv, deps({ isConnected: () => false, needsReauth: () => true }));
    expect(text(r)).toMatch(/not connected/i);
  });

  it('teams: its token lasts about an hour, so the human refreshes it with the window on the command', async () => {
    const d = deps();
    const r = await runBackfill({ source: 'teams', since: '3m' }, localEnv, d);
    expect(d.spawned).toEqual([]);
    expect(text(r)).toContain('align connect teams --since 3m');
  });
});

describe('the input is closed', () => {
  it.each([
    [{ source: 'github', since: '1y', token: 'ghp_x' }, 'token'],
    [{ source: 'github', api_key: 'k' }, 'api_key'],
    [{ source: 'github', since: '1y', classify: true }, 'classify'],
  ])('rejects %j naming the unknown property', async (args, bad) => {
    const d = deps();
    await expect(runBackfill(args as never, localEnv, d)).rejects.toThrow(bad);
    expect(d.spawned).toEqual([]);
    expect(d.recorded).toEqual([]);
  });

  it('a rejected token is never echoed back in the error', async () => {
    await expect(runBackfill({ source: 'github', token: 'ghp_SECRETVALUE' } as never, localEnv, deps())).rejects.not.toThrow(/SECRETVALUE/);
  });

  it('tells the agent how a source gets connected: by the human, with the CLI', async () => {
    await expect(runBackfill({ source: 'github', token: 'x' } as never, localEnv, deps())).rejects.toThrow(/align connect/);
  });

  it.each(['git', 'docs', 'sessions', 'zoom', 'nope', ''])('source %j is not backfillable and the error lists the ones that are', async (source) => {
    await expect(runBackfill({ source } as never, localEnv, deps())).rejects.toThrow(BACKFILL_SOURCES.join(', '));
  });

  it('review 9: a value that is not one of the sources is never echoed (a 40-character token fits a slice)', async () => {
    const secret = `ghp_${'Q'.repeat(36)}`;
    try { await runBackfill({ source: secret } as never, localEnv, deps()); } catch (e) {
      expect((e as Error).message).not.toContain('ghp_');
      expect((e as Error).message).not.toContain('QQQQ');
      return;
    }
    throw new Error('should have thrown');
  });

  it('review 9: a non-string source is not echoed either', async () => {
    await expect(runBackfill({ source: { a: 'ghp_x' } } as never, localEnv, deps())).rejects.not.toThrow(/ghp_x/);
  });

  it('source is required', async () => {
    await expect(runBackfill({} as never, localEnv, deps())).rejects.toThrow(/source/);
  });
});

describe('only the local graph is backfilled', () => {
  it('a hosted server is refused before anything is read', async () => {
    const d = deps();
    await expect(runBackfill({ source: 'github' }, cloudEnv, d)).rejects.toThrow(/local/);
    expect(d.spawned).toEqual([]);
  });
});

describe('the sources it takes', () => {
  it('are exactly the ones `align connect --source` takes (one writer, checked from the other side)', async () => {
    const { localConnectorIds } = await import('../commands/setup.js');
    expect([...BACKFILL_SOURCES].sort()).toEqual(localConnectorIds().sort());
  });
});

describe('the tool name', () => {
  it('is align_backfill', () => {
    expect(BACKFILL_TOOL).toBe('align_backfill');
  });
});

describe('journey 5: returns inside the budget', () => {
  it('well under 500 ms with the real clock (the 300 ms start confirmation is the ceiling of the wait)', async () => {
    const t0 = performance.now();
    await runBackfill({ source: 'github', since: '1y' }, localEnv, deps());
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

vi.setConfig({ testTimeout: 30_000 });
