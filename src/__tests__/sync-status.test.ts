import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { collectStatus, renderStatus, type StatusDeps, TEAMS_NOTE } from '../lib/sync/status.js';
import { beginRun, markNeedsReauth, saveRun } from '../lib/sync/sync-state.js';

/**
 * L5 Test List (align_sync status):
 * - Per connected source: scope, last success, status, items last run, discussion pending and skip counts, with NO item content.
 * - Given Teams connected, its line carries the manual-refresh note (Decision 21). Given a refused token, the exact re-auth command.
 * - Given rows awaiting re-link, the count; given none, no line. Given nothing connected, the command to connect.
 * - A running sync or backfill is said to be running.
 */
vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-status-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const deps = (connected: string[], over: Partial<StatusDeps> = {}): StatusDeps => ({
  dbPath, isConnected: (id) => connected.includes(id), syncRunning: () => false, backfill: () => null, backfillAlive: () => false, ...over,
});
const exec = (q: string) => { const x = new DatabaseSync(dbPath); try { x.exec(q); } finally { x.close(); } };

describe('collectStatus', () => {
  it('reports scope, last success, items, skip counts and discussion pending for a synced GitHub', () => {
    const key = { source: 'github', scopeKey: 'repo:o/r', scope: 'team' as const };
    beginRun(dbPath, key, null, '2026-10-10T11:00:00.000Z');
    saveRun(dbPath, key, { status: 'partial', high_water: null, pending_until: '2026-09-20T00:00:00.000Z', items: 120, skips: [{ kind: 'vendor_cap', count: 2, detail: 'x' }, { kind: 'vendor_cap', count: 1, detail: 'y' }, { kind: 'shape', count: 4, detail: 'z' }], successAt: '2026-10-10T11:00:00.000Z' });
    exec(`INSERT INTO decisions (id, title, summary, platform, detail_pending) VALUES ('a', 'a', 's', 'github', 1), ('b', 'b', 's', 'github', 1), ('c', 'c', 's', 'github', 0)`);
    const gh = collectStatus(deps(['github'])).sources.find((s) => s.id === 'github')!;
    expect(gh).toMatchObject({
      connected: true, scope: "everyone's items in o/r", status: 'partial', last_success_at: '2026-10-10T11:00:00.000Z', items_last_run: 120,
      discussion_pending: 2, skips: { vendor_cap: 3, shape: 4 }, reached_back_to: '2026-09-20T00:00:00.000Z',
    });
  });

  it('a connected source that never ran reads "never" and "your own items"; an unconnected one says how to connect', () => {
    const r = collectStatus(deps(['jira']));
    expect(r.sources.find((s) => s.id === 'jira')).toMatchObject({ status: 'never', scope: 'your own items', connected: true });
    expect(r.sources.find((s) => s.id === 'slack')).toMatchObject({ status: 'not_connected', connected: false, next_step: 'Not connected. Ask the person to run: align connect slack' });
  });

  it('a refused token carries the exact re-auth command', () => {
    markNeedsReauth(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, null, '2026-10-10T11:00:00.000Z');
    expect(collectStatus(deps(['jira'])).sources.find((s) => s.id === 'jira')).toMatchObject({ status: 'needs_reauth', next_step: 'The provider refused the saved token. Ask the person to run: align connect jira' });
  });

  it('Teams carries the manual-refresh note', () => {
    expect(collectStatus(deps(['teams'])).sources.find((s) => s.id === 'teams')!.next_step).toBe(TEAMS_NOTE);
    expect(TEAMS_NOTE).toBe('Teams: refresh manually with `align connect teams` (its token lasts about an hour). Only yours until then.');
  });

  it('a running sync, or a live backfill, is said to be running', () => {
    const s = collectStatus(deps(['github', 'slack'], {
      syncRunning: (id) => id === 'github',
      backfill: (id) => (id === 'slack' ? { source: 'slack', pid: 1, started_at: '2026-10-10T11:00:00.000Z', state: 'running' } : null),
      backfillAlive: () => true,
    })).sources;
    expect(s.find((x) => x.id === 'github')!.running).toBe('sync');
    expect(s.find((x) => x.id === 'slack')!.running).toBe('backfill');
    expect(s.find((x) => x.id === 'jira')!.running).toBeUndefined();
  });

  it('a finished or dead backfill is not "running"', () => {
    const s = collectStatus(deps(['slack'], { backfill: () => ({ source: 'slack', pid: 1, started_at: 'x', state: 'running' }), backfillAlive: () => false })).sources;
    expect(s.find((x) => x.id === 'slack')!.running).toBeUndefined();
  });

  it('carries no item content: the serialised result holds none of the stored titles or summaries', () => {
    exec(`INSERT INTO decisions (id, title, summary, platform, detail_pending) VALUES ('a', 'SECRET-TITLE-do-not-leak', 'SECRET-BODY', 'github', 1)`);
    const json = JSON.stringify(collectStatus(deps(['github'])));
    expect(json).not.toContain('SECRET');
  });

  it('counts the rows awaiting re-link', () => {
    exec(`INSERT INTO decisions (id, title, summary, platform, source_url, enriched_at) VALUES ('a', 'a', 's', 'github', 'https://github.com/o/r/pull/1', NULL), ('b', 'b', 's', 'github', 'https://github.com/o/r/pull/2', '2026-10-01')`);
    expect(collectStatus(deps([])).rows_awaiting_relink).toBe(1);
  });
});

describe('renderStatus', () => {
  it('connected sources only, one line each, with the next step beneath', () => {
    const text = renderStatus(collectStatus(deps(['teams'])));
    expect(text).toContain('Microsoft Teams (your own items): not synced yet.');
    expect(text).toContain(TEAMS_NOTE);
    expect(text).not.toContain('GitHub');
  });

  it('nothing connected: says how to start', () => {
    expect(renderStatus(collectStatus(deps([])))).toBe('No source is connected. Ask the person to run: align connect <source>');
  });

  it('the re-link line appears with a count and is absent at zero', () => {
    exec(`INSERT INTO decisions (id, title, summary, platform, source_url, enriched_at) VALUES ('a', 'a', 's', 'github', 'https://github.com/o/r/pull/1', NULL)`);
    expect(renderStatus(collectStatus(deps([])))).toContain('1 stored items wait for their links to be finished');
    exec('UPDATE decisions SET enriched_at = ' + "'2026-10-01'");
    expect(renderStatus(collectStatus(deps([])))).not.toContain('wait for their links');
  });

  it('a synced source reads as one honest sentence', () => {
    const key = { source: 'github', scopeKey: 'yours', scope: 'yours' as const };
    beginRun(dbPath, key, null, 'x');
    saveRun(dbPath, key, { status: 'ok', high_water: null, pending_until: null, items: 12, skips: [], successAt: '2026-10-10T11:58:00.000Z' });
    expect(renderStatus(collectStatus(deps(['github'])))).toBe('GitHub (your own items): ok; last synced 2026-10-10 11:58 UTC; 12 items read last run.');
  });
});

describe('journey 5: a status call inside the agent', () => {
  it('over a 2,000-row graph with 1,000 rows pending and 500 unfinished, the p95 of 20 calls is under 500 ms', () => {
    const x = new DatabaseSync(dbPath);
    x.exec('BEGIN');
    const put = x.prepare(`INSERT INTO decisions (id, title, summary, platform, source_url, detail_pending, enriched_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 2000; i++) put.run(`d${i}`, `t${i}`, 's'.repeat(400), i % 2 ? 'github' : 'slack', `https://github.com/o/r/pull/${i}`, i % 2 ? 1 : 0, i % 4 === 0 ? null : '2026-10-01');
    x.exec('COMMIT');
    x.close();
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      renderStatus(collectStatus(deps(['github', 'slack', 'jira'])));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(0.95 * times.length) - 1]!).toBeLessThan(500);
    // and the work was real: the counts it reports are the seeded ones
    const r = collectStatus(deps(['github']));
    expect(r.sources.find((s) => s.id === 'github')!.discussion_pending).toBe(1000);
    expect(r.rows_awaiting_relink).toBe(500);
  });
});
