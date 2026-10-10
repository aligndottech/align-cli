import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FetcherAuthError } from '@aligndottech/connector-core';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (t: string) => { const v = new Float32Array(384).fill(0.01); v[t.length % 7] = 1; return v; }),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { syncSource } from '../lib/sync/run-source.js';
import { acquireLock } from '../lib/sync/lock.js';
import { readRows } from '../lib/sync/sync-state.js';
import { type Harness, harness, NOW, pr, slackThread } from './helpers/sync-env.js';

/**
 * L5 Test List (one source, one run):
 * - Given high_water H and a complete run, the next run's since is H minus 1 day and high_water advances to the report's highWater.
 * - Given an incomplete run, high_water does not move and pending_until is set; the next run fetches until = P; when it completes, pending clears
 *   and high_water is the TRUE top of the cycle (not the clamped last run's).
 * - Given a kill after batch 2 of 4, high_water reflects batch 2's committed items only, and the next run resumes from there.
 * - Given a refused token (thrown, or an auth skip with nothing read), status = needs_reauth and nothing else about the source changes.
 *   An auth skip beside real items is a partial read, not a dead token.
 * - Given a held lock with a live pid, "locked" and no fetch. Given a dead pid, it is taken over.
 * - Given a running backfill of the source, no sync. Given Teams in the background, "manual" and no fetch.
 * - Slack: a thread with a reply in 30 days is a hotThread; 31 days is not and the limit is named once. A partial item merges, keeps the stored title, and is idempotent.
 * - GitHub only: the drain runs after the window read, even when the window brought nothing.
 * - Never classifies: ingest runs with classify:false.
 */
vi.setConfig({ testTimeout: 60_000 });
let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

function sql<T = Record<string, unknown>>(q: string, ...a: Array<string | number>): T[] {
  const db = new DatabaseSync(h.dbPath);
  try { return db.prepare(q).all(...a) as T[]; } finally { db.close(); }
}
const row = () => readRows(h.dbPath, 'github')[0]!;
const D = (iso: string, days: number) => new Date(Date.parse(iso) - days * 86_400_000).toISOString();

describe('the watermark', () => {
  it('a complete first run: high_water becomes the report highWater, the next run starts one day before it', async () => {
    h.script({ items: [pr(1, '2026-10-01T00:00:00.000Z'), pr(2, '2026-10-05T00:00:00.000Z')], report: { highWater: '2026-10-05T00:00:00.000Z' } });
    const out = await syncSource('github', h.env);
    expect(out).toMatchObject({ state: 'ok', read: 2, created: 2 });
    expect(row()).toMatchObject({ status: 'ok', high_water: '2026-10-05T00:00:00.000Z', pending_until: null, items_last_run: 2, last_success_at: NOW.toISOString() });
    // the first run read the default window from now
    expect(h.fetchCalls[0]!.win).toEqual({ since: D(NOW.toISOString(), 180) });

    h.script({ items: [pr(3, '2026-10-09T00:00:00.000Z')], report: { highWater: '2026-10-09T00:00:00.000Z' } });
    await syncSource('github', h.env);
    expect(h.fetchCalls[1]!.win).toEqual({ since: '2026-10-04T00:00:00.000Z' });
    expect(row().high_water).toBe('2026-10-09T00:00:00.000Z');
  });

  it('a second example: a different first window and highWater', async () => {
    h.script({ items: [pr(7, '2026-08-15T00:00:00.000Z')], report: { highWater: '2026-08-15T00:00:00.000Z' } });
    await syncSource('github', h.env);
    expect(row().high_water).toBe('2026-08-15T00:00:00.000Z');
    h.script({ items: [] });
    await syncSource('github', h.env);
    expect(h.fetchCalls[1]!.win.since).toBe('2026-08-14T00:00:00.000Z');
  });

  it('a complete read with no highWater (nothing carried a stamp) does not move the watermark', async () => {
    h.script({ items: [] });
    await syncSource('github', h.env);
    expect(row().high_water).toBeNull();
  });

  it('an incomplete run: high_water stays, pending_until is the oldest reached, status partial; the next run reads UNTIL it', async () => {
    h.script({
      items: [pr(1, '2026-10-09T00:00:00.000Z'), pr(2, '2026-09-20T00:00:00.000Z')],
      report: { complete: false, highWater: '2026-10-09T00:00:00.000Z', oldestReached: '2026-09-20T00:00:00.000Z', skips: [{ kind: 'vendor_cap', count: 1, detail: 'GitHub search ceiling' }] },
    });
    const out = await syncSource('github', h.env);
    expect(out).toMatchObject({ state: 'partial', reachedBack: '2026-09-20T00:00:00.000Z' });
    expect(row()).toMatchObject({ status: 'partial', high_water: null, pending_until: '2026-09-20T00:00:00.000Z' });

    h.script({ items: [pr(3, '2026-09-10T00:00:00.000Z')], report: { highWater: '2026-09-10T00:00:00.000Z' } });
    const second = await syncSource('github', h.env);
    expect(h.fetchCalls[1]!.win).toEqual({ since: D(NOW.toISOString(), 180), until: '2026-09-20T00:00:00.000Z' });
    expect(second.state).toBe('ok');
    // the cycle's TRUE top (run 1's newest item), not the clamped last run's 09-10
    expect(row()).toMatchObject({ status: 'ok', pending_until: null, high_water: '2026-10-09T00:00:00.000Z' });
  });

  it('a kill after batch 2 of 4: high_water is batch 2\'s newest only, and the next run resumes from there', async () => {
    const items = [1, 2, 3, 4].map((n) => pr(n, `2026-10-0${n}T00:00:00.000Z`));
    // newest first, as the SDK returns them
    h.script({ items: [...items].reverse(), report: { highWater: '2026-10-04T00:00:00.000Z' } });
    const real = h.env.client.ingestBatch.bind(h.env.client);
    let batches = 0;
    const killing = { ...h.env, batchSize: 1, client: { ...h.env.client, ingestBatch: async (...a: Parameters<typeof real>) => { batches += 1; if (batches === 3) throw new Error('killed'); return real(...a); } } };
    const out = await syncSource('github', killing);
    expect(out.state).toBe('error');
    expect(row().high_water).toBe('2026-10-02T00:00:00.000Z'); // batches 1 and 2 (oldest first) only
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(2);

    h.script({ items: [items[2]!, items[3]!], report: { highWater: '2026-10-04T00:00:00.000Z' } });
    const resumed = await syncSource('github', { ...h.env, batchSize: 1 });
    expect(h.fetchCalls[1]!.win.since).toBe('2026-10-01T00:00:00.000Z'); // resumes at batch 2's stamp minus a day
    expect(resumed.state).toBe('ok');
    expect(row().high_water).toBe('2026-10-04T00:00:00.000Z');
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(4);
  });

  it('a kill during an INCOMPLETE run moves nothing (an unfinished top must not become a resume point)', async () => {
    h.script({ items: [pr(1, '2026-10-09T00:00:00.000Z'), pr(2, '2026-09-20T00:00:00.000Z')], report: { complete: false, highWater: '2026-10-09T00:00:00.000Z', oldestReached: '2026-09-20T00:00:00.000Z' } });
    const real = h.env.client.ingestBatch.bind(h.env.client);
    let n = 0;
    const killing = { ...h.env, batchSize: 1, client: { ...h.env.client, ingestBatch: async (...a: Parameters<typeof real>) => { n += 1; if (n === 2) throw new Error('killed'); return real(...a); } } };
    await syncSource('github', killing);
    expect(row().high_water).toBeNull();
  });

  it('a future-dated highWater from the vendor is not trusted', async () => {
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z')], report: { highWater: '2027-01-01T00:00:00.000Z' } });
    await syncSource('github', h.env);
    expect(row().high_water).not.toBe('2027-01-01T00:00:00.000Z');
  });

  it('a user window recorded by align_backfill is the floor of the first run', async () => {
    const db = new DatabaseSync(h.dbPath);
    db.exec(`INSERT INTO source_sync (source_id, scope_key, scope, window_since) VALUES ('github', 'yours', 'yours', '2025-10-10T12:00:00.000Z')`);
    db.close();
    h.script({ items: [] });
    await syncSource('github', h.env);
    expect(h.fetchCalls[0]!.win.since).toBe('2025-10-10T12:00:00.000Z');
  });

  it('"all" (a recorded NULL window) reads with no lower bound', async () => {
    const db = new DatabaseSync(h.dbPath);
    db.exec(`INSERT INTO source_sync (source_id, scope_key, scope, window_since) VALUES ('github', 'yours', 'yours', NULL)`);
    db.close();
    h.script({ items: [] });
    await syncSource('github', h.env);
    expect(h.fetchCalls[0]!.win).toEqual({});
  });

  it('a new team scope inherits the depth the person asked for', async () => {
    const db = new DatabaseSync(h.dbPath);
    db.exec(`INSERT INTO source_sync (source_id, scope_key, scope, window_since) VALUES ('github', 'yours', 'yours', '2025-10-10T12:00:00.000Z')`);
    db.close();
    h.script({ items: [] });
    await syncSource('github', { ...h.env, scopeOf: async () => ({ scopeKey: 'repo:o/r', scope: 'team' as const, repo: 'o/r' }) });
    expect(h.fetchCalls[0]!.win.since).toBe('2025-10-10T12:00:00.000Z');
    expect(readRows(h.dbPath, 'github').map((r) => r.scope_key).sort()).toEqual(['repo:o/r', 'yours']);
  });
});

describe('a refused token', () => {
  it('a thrown 401: needs_reauth is recorded, nothing was ingested, and the watermark is where it was', async () => {
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z')], report: { highWater: '2026-10-05T00:00:00.000Z' } });
    await syncSource('github', h.env);
    h.script(new FetcherAuthError('GitHub'));
    const out = await syncSource('github', h.env);
    expect(out.state).toBe('needs_reauth');
    expect(out.message).toContain('align connect github');
    expect(row()).toMatchObject({ status: 'needs_reauth', high_water: '2026-10-05T00:00:00.000Z' });
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(1);
  });

  it('a second example: a worded 401 from a fetcher that throws a plain Error', async () => {
    h.script(new Error('Linear API failed (401): Authentication required, not authenticated'));
    expect((await syncSource('github', h.env)).state).toBe('needs_reauth');
  });

  it('a source in needs_reauth is not read again until the person reconnects (no request)', async () => {
    h.script(new FetcherAuthError('GitHub'));
    await syncSource('github', h.env);
    h.fetchCalls.length = 0;
    const out = await syncSource('github', h.env);
    expect(out.state).toBe('needs_reauth');
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('an auth skip and NOTHING read is the token: needs_reauth', async () => {
    h.script({ items: [], report: { complete: false, skips: [{ kind: 'auth', count: 3, detail: 'channels where Teams refused the token' }] } });
    expect((await syncSource('github', h.env)).state).toBe('needs_reauth');
  });

  it('an auth skip BESIDE real items is a repo the token cannot see: a partial read, the token is fine', async () => {
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z')], report: { complete: false, highWater: '2026-10-05T00:00:00.000Z', skips: [{ kind: 'auth', count: 1, detail: 'o/private is not visible to this token' }] } });
    const out = await syncSource('github', h.env);
    expect(out.state).toBe('partial');
    expect(row().status).toBe('partial');
  });

  it('any other failure is an error, recorded with its reason, and not a reauth', async () => {
    h.script(new Error('socket hang up'));
    const out = await syncSource('github', h.env);
    expect(out.state).toBe('error');
    expect(row().status).toBe('error');
    expect(JSON.parse(row().skips_last_run!)).toEqual([{ kind: 'error', count: 1, detail: 'socket hang up' }]);
  });
});

describe('who may run', () => {
  it('a held lock with a live pid: locked, no fetch; a dead pid: taken over', async () => {
    const held = acquireLock('sync-github', { dir: h.lockDir, pid: 4242, alive: () => true });
    expect(held.ok).toBe(true);
    h.script({ items: [] });
    const out = await syncSource('github', h.env);
    expect(out.state).toBe('locked');
    expect(h.fetchCalls).toHaveLength(0);
    const dead = harness({}, { alive: (pid) => pid === process.pid });
    try {
      acquireLock('sync-github', { dir: dead.lockDir, pid: 4242, alive: () => true });
      dead.script({ items: [] });
      expect((await syncSource('github', dead.env)).state).toBe('ok');
    } finally { dead.cleanup(); }
  });

  it('the lock is released after a run, and after a failed one', async () => {
    h.script(new Error('boom'));
    await syncSource('github', h.env);
    h.script({ items: [] });
    expect((await syncSource('github', h.env)).state).toBe('ok');
  });

  it('a running backfill of the same source: no sync, no fetch', async () => {
    h.script({ items: [] });
    const out = await syncSource('github', { ...h.env, backfillRunning: (s) => s === 'github' });
    expect(out.state).toBe('backfill_running');
    expect(h.fetchCalls).toHaveLength(0);
    h.fetchCalls.length = 0;
    expect((await syncSource('jira', { ...h.env, backfillRunning: (s) => s === 'github' })).state).toBe('ok');
  });

  it('a source with no saved token: not_connected with the command to run', async () => {
    const out = await syncSource('github', { ...h.env, tokens: () => null });
    expect(out).toMatchObject({ state: 'not_connected' });
    expect(out.message).toContain('align connect github');
  });

  it('Teams in the background is manual (its token lasts about an hour); Teams from the CLI is read', async () => {
    h.script({ items: [] });
    expect((await syncSource('teams', h.env, { trigger: 'background' })).state).toBe('manual');
    expect(h.fetchCalls).toHaveLength(0);
    expect((await syncSource('teams', h.env, { trigger: 'cli' })).state).toBe('ok');
    expect(h.fetchCalls).toHaveLength(1);
  });
});

describe('Slack threads', () => {
  const T1 = '1790000001.000100';
  const T2 = '1790000002.000100';
  const seedThreads = async (act1: string, act2: string) => {
    h.script({ items: [slackThread('C1', T1, 'should we use a queue?\nalice: yes, SQS\nbob: agreed', act1), slackThread('C1', T2, 'pick a db\ncarol: postgres', act2)], report: { highWater: act1 > act2 ? act1 : act2 } });
    await syncSource('slack', h.env);
  };

  it('a thread with a reply 29 days ago is a hotThread of the next run; one quiet for 31 days is not, and the limit is named once', async () => {
    await seedThreads(D(NOW.toISOString(), 29), D(NOW.toISOString(), 31));
    h.script({ items: [] });
    const out = await syncSource('slack', h.env);
    expect(h.fetchCalls[1]!.win.hotThreads).toEqual([{ channel: 'C1', ts: T1 }]);
    const quiet = out.skips.filter((k) => /quiet for more than 30 days/.test(k.detail));
    expect(quiet).toHaveLength(1);
    expect(quiet[0]).toMatchObject({ kind: 'shape', count: 1 });
  });

  it('nothing hot: no hotThreads key at all (the SDK refuses an empty list with no since)', async () => {
    await seedThreads(D(NOW.toISOString(), 40), D(NOW.toISOString(), 50));
    h.script({ items: [] });
    await syncSource('slack', h.env);
    expect('hotThreads' in h.fetchCalls[1]!.win).toBe(false);
  });

  it('a partial hot-thread item is MERGED into the stored thread, keeps the stored title, and merging again changes nothing', async () => {
    await seedThreads(D(NOW.toISOString(), 3), D(NOW.toISOString(), 3));
    const stored = () => sql<{ title: string; summary: string }>(`SELECT title, summary FROM decisions WHERE source_url LIKE '%${T1.replace('.', '')}'`)[0]!;
    const before = stored();
    const partial = slackThread('C1', T1, 'carol: shipping it Friday', D(NOW.toISOString(), 1), { partial: true, title: 'carol: shipping it Friday' });
    h.script({ items: [partial], report: { highWater: partial.updated_at! } });
    await syncSource('slack', h.env);
    const after = stored();
    expect(after.title).toBe(before.title);
    expect(after.summary).toBe(`${before.summary}\ncarol: shipping it Friday`);
    h.script({ items: [partial], report: { highWater: partial.updated_at! } });
    await syncSource('slack', h.env);
    expect(stored()).toEqual(after);
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(2);
  });
});

describe('GitHub discussion drain and classification', () => {
  it('the drain runs after the window read for github, even when the window brought nothing; it does not run for jira', async () => {
    const drain = vi.fn(async () => ({ enriched: 4, remaining: 2, skips: [] }));
    h.script({ items: [] });
    const out = await syncSource('github', { ...h.env, drain });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(out.drain).toEqual({ enriched: 4, remaining: 2, skips: [] });
    await syncSource('jira', { ...h.env, drain });
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('no drain after a refused token or a failed read', async () => {
    const drain = vi.fn(async () => ({ enriched: 0, remaining: 0, skips: [] }));
    h.script(new FetcherAuthError('GitHub'));
    await syncSource('github', { ...h.env, drain });
    h.script(new Error('boom'));
    await syncSource('github', { ...h.env, drain });
    expect(drain).not.toHaveBeenCalled();
  });

  it('never classifies: every ingest runs with classify:false and keyed:true', async () => {
    const calls: unknown[] = [];
    const real = h.env.client.ingestBatch.bind(h.env.client);
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z'), pr(2, '2026-10-06T00:00:00.000Z')] });
    await syncSource('github', { ...h.env, client: { ...h.env.client, ingestBatch: async (items, opts) => { calls.push(opts); return real(items, opts); } } });
    expect(calls).toEqual([{ classify: false, keyed: true }]);
  });

  it('an items-first GitHub item is stored pending', async () => {
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z', { detail_pending: true })] });
    await syncSource('github', h.env);
    expect(sql('SELECT detail_pending FROM decisions')[0]).toEqual({ detail_pending: 1 });
  });
});

void NOW;
