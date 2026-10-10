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
    saveRun(dbPath, key, { attemptAt: '2026-10-10T12:00:00.000Z', status: 'partial', high_water: null, pending_until: '2026-09-20T00:00:00.000Z', items: 120, skips: [{ kind: 'vendor_cap', count: 2, detail: 'x' }, { kind: 'vendor_cap', count: 1, detail: 'y' }, { kind: 'shape', count: 4, detail: 'z' }], successAt: '2026-10-10T11:00:00.000Z' });
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

  it('L4: a Jira or Confluence team scope reads as the projects or spaces, not as its raw key (two sources)', () => {
    beginRun(dbPath, { source: 'jira', scopeKey: 'jira:ALI,OPS', scope: 'team' }, null, '2026-10-10T11:00:00.000Z');
    beginRun(dbPath, { source: 'confluence', scopeKey: 'confluence:ENG', scope: 'team' }, null, '2026-10-10T11:00:00.000Z');
    const r = collectStatus(deps(['jira', 'confluence']));
    expect(r.sources.find((s) => s.id === 'jira')!.scope).toBe("everyone's items in Jira projects ALI, OPS");
    expect(r.sources.find((s) => s.id === 'confluence')!.scope).toBe("everyone's items in Confluence space ENG");
  });

  describe('L4: only the scope in force is described; older scopes are counted, not listed', () => {
    const team = { source: 'jira', scopeKey: 'jira:OPS', scope: 'team' as const };
    const yours = { source: 'jira', scopeKey: 'yours', scope: 'yours' as const };
    beforeEach(() => {
      beginRun(dbPath, yours, null, '2026-10-01T00:00:00.000Z');
      saveRun(dbPath, yours, { attemptAt: '2026-10-01T01:00:00.000Z', status: 'partial', high_water: null, pending_until: null, items: 7, skips: [{ kind: 'error', count: 3, detail: 'old trouble' }], successAt: '2026-10-01T01:00:00.000Z' });
      beginRun(dbPath, team, null, '2026-10-09T00:00:00.000Z');
      saveRun(dbPath, team, { attemptAt: '2026-10-09T01:00:00.000Z', status: 'ok', high_water: null, pending_until: null, items: 40, skips: [], successAt: '2026-10-09T01:00:00.000Z' });
    });

    it('the active scope (given by the caller) is the only one described, its numbers are its own, and the rest are counted', () => {
      const j = collectStatus(deps(['jira'], { activeScopeKey: () => 'jira:OPS' })).sources.find((s) => s.id === 'jira')!;
      expect(j).toMatchObject({ scope: "everyone's items in Jira project OPS", status: 'ok', items_last_run: 40, older_scopes: 1 });
      expect(j.missing).toBeUndefined();
      expect(j.skips).toEqual({});
      expect(renderStatus({ sources: [j], rows_awaiting_relink: 0 })).toContain('1 older scope kept (not read)');
    });

    it('going back to yours makes the other row the older one', () => {
      const j = collectStatus(deps(['jira'], { activeScopeKey: () => 'yours' })).sources.find((s) => s.id === 'jira')!;
      expect(j).toMatchObject({ scope: 'your own items', items_last_run: 7, older_scopes: 1 });
      expect(j.missing).toEqual(['your own items: 3 old trouble']);
    });

    it('with no answer from the caller, the scope most recently started is the active one; a single scope has no older line', () => {
      const j = collectStatus(deps(['jira'])).sources.find((s) => s.id === 'jira')!;
      expect(j.scope).toBe("everyone's items in Jira project OPS");
      const only = collectStatus(deps(['github'])).sources.find((s) => s.id === 'github')!;
      expect(only.older_scopes).toBeUndefined();
      expect(renderStatus({ sources: [only], rows_awaiting_relink: 0 })).not.toContain('older scope');
    });

    it('an agent-chosen scope waiting for a person is said, with the command', () => {
      const j = collectStatus(deps(['jira'], { pendingScope: () => "everyone's items in Jira project BETA" })).sources.find((s) => s.id === 'jira')!;
      expect(j.next_step).toBe("Team scope for jira is waiting for you to confirm (everyone's items in Jira project BETA): run `align sync jira` (it will show what it reads)");
    });
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

describe('a partial source says what is actually missing', () => {
  const key = { source: 'slack', scopeKey: 'yours', scope: 'yours' as const };
  it('a hole is listed in the fetcher\'s words, with the last COMPLETE sync and the last attempt apart, and no "older history" claim', () => {
    beginRun(dbPath, key, null, 'x');
    saveRun(dbPath, key, { attemptAt: '2026-10-09T10:00:00.000Z', status: 'ok', high_water: null, pending_until: null, items: 5, skips: [], successAt: '2026-10-09T10:00:00.000Z' });
    saveRun(dbPath, key, { attemptAt: '2026-10-10T10:00:00.000Z', status: 'partial', high_water: null, pending_until: null, items: 3, skips: [{ kind: 'error', count: 2, detail: 'channels the token could not read' }, { kind: 'shape', count: 9, detail: 'threads with no human message' }] });
    const s = collectStatus(deps(['slack'])).sources.find((x) => x.id === 'slack')!;
    expect(s).toMatchObject({ status: 'partial', last_success_at: '2026-10-09T10:00:00.000Z', last_attempt_at: '2026-10-10T10:00:00.000Z', missing: ['your own items: 2 channels the token could not read'] });
    expect(s.reached_back_to).toBeUndefined();
    const text = renderStatus(collectStatus(deps(['slack'])));
    expect(text).toContain('last complete sync 2026-10-09 10:00 UTC');
    expect(text).toContain('last tried 2026-10-10 10:00 UTC');
    expect(text).toContain('not read last time: your own items: 2 channels the token could not read');
    expect(text).not.toContain('older history');
  });

  it('a date-ordered cut says how far back it got; a refused repo names its scope, not the others', () => {
    const team = { source: 'github', scopeKey: 'repo:upstream/oss', scope: 'team' as const };
    beginRun(dbPath, team, null, 'x');
    saveRun(dbPath, team, { attemptAt: 'x', status: 'partial', high_water: null, pending_until: '2026-09-01T00:00:00.000Z', items: 0, skips: [{ kind: 'auth', count: 1, detail: 'repository not searched' }] });
    const s = collectStatus(deps(['github'])).sources.find((x) => x.id === 'github')!;
    expect(s.reached_back_to).toBe('2026-09-01T00:00:00.000Z');
    expect(s.missing).toEqual(['upstream/oss: 1 repository not searched']);
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
    saveRun(dbPath, key, { attemptAt: '2026-10-10T12:00:00.000Z', status: 'ok', high_water: null, pending_until: null, items: 12, skips: [], successAt: '2026-10-10T11:58:00.000Z' });
    expect(renderStatus(collectStatus(deps(['github'])))).toBe('GitHub (your own items): ok; last complete sync 2026-10-10 11:58 UTC; 12 items read last run.');
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
