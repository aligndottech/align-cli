import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillDir, liveBackfills, pidAlive, readStatus, startBackfillChild, statusPath } from '../lib/backfill-state.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { type BackfillDeps, defaultBackfillDeps, runBackfill } from '../lib/mcp-backfill.js';

/**
 * Re-review A: MCP does not queue requests, so several tool calls can be in flight at once. With the
 * REAL slot reservation, the REAL status files and a REAL (harmless) child process, five calls at
 * once start at most one child per source and three in all. The control runs them one after another.
 */
const env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: '/ignored/graph.db' } as EnvironmentConfig;
const KEYS = ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-par-'));
  for (const k of KEYS) process.env[k] = scratch;
});
afterEach(() => {
  const dir = backfillDir();
  if (dir) for (const s of liveBackfills(dir)) { try { process.kill(s.pid); } catch { /* gone */ } }
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Real reserve/live/status files and a real child; only the config store and the DB are doubled. */
function realDeps(): BackfillDeps {
  const real = defaultBackfillDeps(env);
  return {
    ...real,
    isConnected: () => true,
    needsReauth: () => false,
    recordWindow: () => {},
    start: async (source) => {
      const dir = backfillDir()!;
      // A harmless child that outlives the test, so its slot is still held when the later calls look.
      await new Promise((r) => setTimeout(r, 25)); // the window in which the old code let everyone through
      return startBackfillChild(source, [], statusPath(dir, source), { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 5000)'] });
    },
  };
}

describe('parallel tool calls', () => {
  it('five at once for ONE source start exactly one child', async () => {
    const d = realDeps();
    const replies = await Promise.all(Array.from({ length: 5 }, () => runBackfill({ source: 'github' }, env, d)));
    expect(replies.filter((r) => r.started)).toHaveLength(1);
    expect(replies.filter((r) => !r.started && /already running/.test(r.text))).toHaveLength(4);
    const live = liveBackfills(backfillDir()!);
    expect(live.map((s) => s.source)).toEqual(['github']);
    expect(pidAlive(live[0]!.pid)).toBe(true);
  });

  it('five at once for FIVE sources start exactly three', async () => {
    const d = realDeps();
    const sources = ['github', 'jira', 'slack', 'linear', 'gitlab'];
    const replies = await Promise.all(sources.map((source) => runBackfill({ source }, env, d)));
    expect(replies.filter((r) => r.started)).toHaveLength(3);
    expect(liveBackfills(backfillDir()!)).toHaveLength(3);
    expect(replies.filter((r) => !r.started).every((r) => /already running/.test(r.text))).toBe(true);
  });

  it('control: the same calls one after another give the same answer', async () => {
    const d = realDeps();
    const sources = ['github', 'github', 'jira', 'slack', 'linear'];
    const started: boolean[] = [];
    for (const source of sources) started.push((await runBackfill({ source }, env, d)).started);
    expect(started).toEqual([true, false, true, true, false]);
  });

  it('the placeholders are gone afterwards: a finished call leaves status files, not locks', async () => {
    const d = realDeps();
    await runBackfill({ source: 'github' }, env, d);
    expect(fs.readdirSync(backfillDir()!).filter((n) => n.endsWith('.lock'))).toEqual([]);
    expect(readStatus(statusPath(backfillDir()!, 'github'))).toMatchObject({ state: 'running' });
  });

  it('a child that fails to start frees its slot for the next call', async () => {
    const d: BackfillDeps = { ...realDeps(), start: async () => ({ ok: false }) };
    const first = await runBackfill({ source: 'github' }, env, d);
    expect(first.started).toBe(false);
    expect(/could not start/.test(first.text)).toBe(true);
    const second = await runBackfill({ source: 'github' }, env, realDeps());
    expect(second.started).toBe(true);
  });
});
