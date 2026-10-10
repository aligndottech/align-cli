import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { FetcherItem } from '@aligndottech/connector-core';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (t: string) => { const v = new Float32Array(384).fill(0.01); v[t.length % 7] = 1; return v; }),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { syncSource } from '../lib/sync/run-source.js';
import { readRows } from '../lib/sync/sync-state.js';
import { type Harness, harness, pr, slackThread } from './helpers/sync-env.js';

/**
 * L5 review: the scenarios a reviewer found that could lose data or wedge a source. Each runs a WINDOW-AWARE
 * fake vendor (it honours since, until and a ceiling, newest first, like the SDK) so a stall shows as
 * items never arriving, not as a flag nobody reads.
 *  W1  a recurring skip of a HOLE kind must not pin every later run to a stale `until`.
 *  W1c control: no skip, every item lands.   W1d: a ceiling cut twice in a row converges.
 *  W2  a future-dated item must not move the watermark past later changes.
 *  W3  another scope's items must not lift this scope's cycle top.
 *  W4  a refused repo is a skip of its scope: it must not block the other scope.
 */
vi.setConfig({ testTimeout: 60_000 });
let h: Harness;
let clock = new Date('2026-10-10T12:00:00.000Z');
let world: FetcherItem[] = [];
let lastWin: { since?: string; until?: string } = {};
let skip: { kind: string; count: number; detail: string } | undefined;
let ceiling: number | undefined;
const START = '2026-10-10T12:00:00.000Z';
/** A source whose fetcher reads ONE newest-first listing (see CUT_KINDS_BY_SOURCE): the only kind where a cut leaves a date line. */
const SRC = 'jira';
const srow = (scope = 'yours') => readRows(h.dbPath, SRC).find((r) => r.scope_key === scope)!;

function setup(over: Parameters<typeof harness>[0] = {}): void {
  clock = new Date(START); world = []; skip = undefined; ceiling = undefined;
  h = harness({ now: () => clock, ...over });
  h.env.fetch = async (_s, _t, win) => {
    lastWin = win;
    const inWin = world.filter((i) => (win.since === undefined || i.updated_at! >= win.since) && (win.until === undefined || i.updated_at! < win.until))
      .sort((a, b) => (a.updated_at! < b.updated_at! ? 1 : -1));
    const cut = ceiling !== undefined && inWin.length > ceiling;
    const items = cut ? inWin.slice(0, ceiling) : inWin;
    // The item ceiling of a single listing (jira, notion, gitlab) emits NO skip: the report is just not complete.
    const skips = skip ? [skip] : [];
    const stamps = items.map((i) => i.updated_at!).sort();
    return { items, report: { scanned: items.length, skips, complete: skips.length === 0 && !cut, ...(stamps.length ? { highWater: stamps.at(-1), oldestReached: stamps[0] } : {}) } } as never;
  };
}
afterEach(() => h?.cleanup());
const ids = (): string[] => {
  const db = new DatabaseSync(h.dbPath);
  try { return (db.prepare('SELECT source_url FROM decisions ORDER BY source_url').all() as Array<{ source_url: string }>).map((r) => r.source_url.split('/').pop()!); } finally { db.close(); }
};
const day = (d: number) => new Date(Date.parse(START) + d * 86_400_000);
const row = (scope = 'yours', src = 'github') => readRows(h.dbPath, src).find((r) => r.scope_key === scope)!;

describe('W1: a recurring hole must not stall the source', () => {
  it('one persistent unreadable-channel skip: five days of new items all land, and no `until` ever pins a run', async () => {
    setup();
    skip = { kind: 'error', count: 1, detail: 'channels the token could not read' };
    world = [pr(1, '2026-10-01T00:00:00.000Z'), pr(2, '2026-10-05T00:00:00.000Z')];
    await syncSource('github', h.env);
    for (let d = 1; d <= 5; d++) {
      clock = day(d);
      world.push(pr(100 + d, new Date(clock.getTime() - 3_600_000).toISOString()));
      await syncSource('github', h.env);
      expect(lastWin.until).toBeUndefined();
    }
    expect(ids()).toEqual(['1', '101', '102', '103', '104', '105', '2']);
    expect(row()).toMatchObject({ status: 'partial', pending_until: null });
  });

  it('W1-control: the same world with no skip lands every item too', async () => {
    setup();
    world = [pr(1, '2026-10-01T00:00:00.000Z'), pr(2, '2026-10-05T00:00:00.000Z')];
    await syncSource('github', h.env);
    for (let d = 1; d <= 5; d++) { clock = day(d); world.push(pr(100 + d, new Date(clock.getTime() - 3_600_000).toISOString())); await syncSource('github', h.env); }
    expect(ids()).toEqual(['1', '101', '102', '103', '104', '105', '2']);
  });

  it('a hole keeps high_water where the last COMPLETE run left it, and the next run re-reads from a day before it', async () => {
    setup();
    world = [pr(1, '2026-10-05T00:00:00.000Z')];
    await syncSource('github', h.env);
    expect(row().high_water).toBe('2026-10-05T00:00:00.000Z');
    skip = { kind: 'auth', count: 1, detail: 'one repo is not visible' };
    clock = day(1); world.push(pr(2, '2026-10-10T20:00:00.000Z'));
    await syncSource('github', h.env);
    expect(row().high_water).toBe('2026-10-05T00:00:00.000Z');
    clock = day(2);
    await syncSource('github', h.env);
    expect(lastWin).toEqual({ since: '2026-10-04T00:00:00.000Z' });
  });

  it('a partial run is an ATTEMPT: last_attempt_at moves, last_success_at does not', async () => {
    setup();
    world = [pr(1, '2026-10-05T00:00:00.000Z')];
    await syncSource('github', h.env);
    const success = row().last_success_at;
    expect(success).toBe(START);
    skip = { kind: 'time_budget', count: 2, detail: 'channels not scanned' };
    clock = day(1);
    await syncSource('github', h.env);
    expect(row()).toMatchObject({ status: 'partial', last_success_at: success, last_attempt_at: day(1).toISOString() });
  });

  it('W1d: a ceiling that cuts twice in a row still converges: every item lands, the watermark lands at the true top, and the next run is incremental', async () => {
    setup();
    ceiling = 2;
    world = [1, 2, 3, 4, 5].map((n) => pr(n, `2026-10-0${n}T00:00:00.000Z`));
    const states: string[] = [];
    for (let run = 0; run < 3; run++) states.push((await syncSource(SRC, h.env)).state);
    expect(states).toEqual(['partial', 'partial', 'ok']);
    expect(ids()).toEqual(['1', '2', '3', '4', '5']);
    expect(srow()).toMatchObject({ high_water: '2026-10-05T00:00:00.000Z', pending_until: null, cycle_top: null, status: 'ok' });
    clock = day(1);
    world.push(pr(6, '2026-10-10T20:00:00.000Z'));
    await syncSource(SRC, h.env);
    expect(lastWin).toEqual({ since: '2026-10-04T00:00:00.000Z' });
    expect(ids()).toContain('6');
  });
});

describe('a source whose listing is not one newest-first stream cannot leave a date line', () => {
  it.each(['slack', 'zoom'])('%s: an incomplete read with a time budget skip and an oldestReached is a HOLE: no pending_until, no until next time', async (source) => {
    setup();
    const cutShaped = async () => ({
      items: [pr(1, '2026-10-05T00:00:00.000Z', { platform: source, source_url: `https://example.test/${source}/1` })],
      report: { scanned: 1, complete: false, highWater: '2026-10-05T00:00:00.000Z', oldestReached: '2026-10-05T00:00:00.000Z', skips: [{ kind: 'time_budget', count: 4, detail: 'channels not scanned' }] },
    }) as never;
    h.env.fetch = async (_s, _t, win) => { lastWin = win; return cutShaped(); };
    await syncSource(source, h.env);
    await syncSource(source, h.env);
    const r = readRows(h.dbPath, source)[0]!;
    expect(r).toMatchObject({ status: 'partial', pending_until: null, high_water: null });
    expect(lastWin.until).toBeUndefined();
  });

  it('the same report on jira, one newest-first listing, IS a cut: the next run reads until it; on github, which interleaves several searches, it is a hole', async () => {
    setup();
    h.env.fetch = async (_s, _t, win) => { lastWin = win; return { items: [pr(1, '2026-10-05T00:00:00.000Z')], report: { scanned: 1, complete: false, highWater: '2026-10-05T00:00:00.000Z', oldestReached: '2026-10-05T00:00:00.000Z', skips: [{ kind: 'time_budget', count: 4, detail: 'issue read stopped; older issues not read' }] } } as never; };
    await syncSource('jira', h.env);
    expect(row('yours', 'jira').pending_until).toBe('2026-10-05T00:00:00.000Z');
    await syncSource('jira', h.env);
    expect(lastWin.until).toBe('2026-10-05T00:00:00.000Z');
    await syncSource('github', h.env);
    expect(row('yours', 'github').pending_until).toBeNull();
    await syncSource('github', h.env);
    expect(lastWin.until).toBeUndefined();
  });
});

describe('W2: a future-dated item', () => {
  it('does not move the watermark, in the per-batch advance or at the end, so a later change is still read', async () => {
    setup();
    world = [pr(1, '2026-10-09T00:00:00.000Z'), pr(2, '2099-01-01T00:00:00.000Z')];
    await syncSource('github', h.env);
    expect(row().high_water).toBe('2026-10-09T00:00:00.000Z');
    clock = new Date('2026-10-12T12:00:00.000Z');
    world.push(pr(3, '2026-10-11T00:00:00.000Z'));
    await syncSource('github', h.env);
    expect(ids()).toContain('3');
  });

  it('a stored watermark already in the future (an older build wrote it) is repaired by the next run', async () => {
    setup();
    world = [pr(1, '2026-10-09T00:00:00.000Z')];
    await syncSource('github', h.env);
    const db = new DatabaseSync(h.dbPath);
    db.exec(`UPDATE source_sync SET high_water = '2099-01-01T00:00:00.000Z'`);
    db.close();
    world.push(pr(2, '2026-10-09T10:00:00.000Z'));
    await syncSource('github', h.env);
    expect(ids()).toContain('2');
    expect(row().high_water).toBe('2026-10-09T10:00:00.000Z');
  });

  it('a future-dated Slack thread is not recorded as activity (it would stay "hot" forever)', async () => {
    setup();
    h.env.fetch = async () => ({ items: [slackThread('C1', '1790000001.000100', 'a\nb', '2099-01-01T00:00:00.000Z')], report: { scanned: 1, skips: [], complete: true } });
    await syncSource('slack', h.env);
    const db = new DatabaseSync(h.dbPath);
    try { expect(db.prepare('SELECT 1 FROM sync_item_state').all()).toHaveLength(0); } finally { db.close(); }
  });
});

describe('W3: the cycle top belongs to its own scope', () => {
  it("another scope's newer items cannot lift this scope's watermark past items it never read", async () => {
    let scope: { scopeKey: string; scope: 'yours' | 'team'; repo?: string } = { scopeKey: 'repo:o/r', scope: 'team', repo: 'o/r' };
    setup({ scopeOf: async () => scope as never });
    const team = [pr(10, '2026-10-01T00:00:00.000Z'), pr(11, '2026-10-09T00:00:00.000Z')];
    const mine = [pr(50, '2026-10-20T00:00:00.000Z', { source_url: 'https://github.com/me/other/pull/50' })];
    const teamFetch = h.env.fetch;
    h.env.fetch = async (s, t, win, sc) => {
      lastWin = win;
      if (scope.scopeKey === 'yours') return { items: mine, report: { scanned: 1, skips: [], complete: true, highWater: '2026-10-20T00:00:00.000Z' } } as never;
      world = team;
      ceiling = win.until === undefined ? 1 : undefined;
      return teamFetch(s, t, win, sc);
    };
    clock = new Date('2026-10-10T00:00:00.000Z');
    await syncSource(SRC, h.env); // team run 1: cut after the newest item
    clock = new Date('2026-10-21T00:00:00.000Z');
    scope = { scopeKey: 'yours', scope: 'yours' };
    await syncSource(SRC, h.env); // an item updated 10-20 is stored, in ANOTHER scope
    team.push(pr(12, '2026-10-15T00:00:00.000Z'));
    scope = { scopeKey: 'repo:o/r', scope: 'team', repo: 'o/r' };
    await syncSource(SRC, h.env); // team run 2: finishes the older part
    expect(srow('repo:o/r').high_water).toBe('2026-10-09T00:00:00.000Z');
    await syncSource(SRC, h.env); // team run 3: incremental, must see PR 12
    expect(ids()).toContain('12');
  });
});

describe('W4: one refused repo is a skip of its scope', () => {
  it('a team-scope read refused with nothing read leaves the other scope healthy and syncing', async () => {
    setup();
    world = [pr(1, '2026-10-09T00:00:00.000Z')];
    await syncSource('github', h.env);
    h.env.scopeOf = async () => ({ scopeKey: 'repo:upstream/oss', scope: 'team', repo: 'upstream/oss' });
    skip = { kind: 'auth', count: 1, detail: 'repository not searched: GitHub will not search upstream/oss for this token (HTTP 422)' };
    const mineItems = world;
    world = []; // the refused repo returns nothing at all: the shape that used to read as a dead token
    const team = await syncSource('github', h.env);
    expect(team.state).toBe('partial');
    expect(readRows(h.dbPath, 'github').map((r) => [r.scope_key, r.status])).toEqual([['repo:upstream/oss', 'partial'], ['yours', 'ok']]);
    h.env.scopeOf = async () => ({ scopeKey: 'yours', scope: 'yours' });
    skip = undefined;
    world = [...mineItems, pr(2, '2026-10-10T00:00:00.000Z')];
    const mine = await syncSource('github', h.env);
    expect(mine.state).toBe('ok');
    expect(ids()).toContain('2');
  });

  it('a THROWN refusal of the token still marks the whole source (the one real needs_reauth)', async () => {
    setup();
    h.env.fetch = async () => { throw new Error('GitHub API failed (401): Bad credentials'); };
    expect((await syncSource('github', h.env)).state).toBe('needs_reauth');
  });
});

describe('a holder that lost its lock stops', () => {
  it('stops before the next batch and records nothing: the new holder owns the source now', async () => {
    setup();
    world = [1, 2, 3].map((n) => pr(n, `2026-10-0${n}T00:00:00.000Z`));
    let checks = 0;
    const lock = h.env.lock;
    const env = { ...h.env, batchSize: 1, lock: (name: string) => { const l = lock(name); return l.ok ? { ...l, owned: () => (checks += 1) <= 1 } : l; } };
    const out = await syncSource('github', env);
    expect(out.state).toBe('locked');
    expect(out.message).toMatch(/took over/);
    expect(ids()).toHaveLength(1); // batch 1 only
    expect(row()).toMatchObject({ status: 'ok', high_water: '2026-10-01T00:00:00.000Z', items_last_run: null });
  });
});

describe('a partial Slack thread whose last message was EDITED', () => {
  const T = '1790000001.000100';
  it('is replaced by the whole thread when it can be read whole: the edit shows once, nothing is duplicated', async () => {
    setup();
    h.env.fetch = async () => ({ items: [slackThread('C1', T, 'q?\nbob: agreed', '2026-10-01T00:00:00.000Z')], report: { scanned: 1, skips: [], complete: true } });
    await syncSource('slack', h.env);
    const partial = slackThread('C1', T, 'bob: agreed (edited)\ncarol: ship it', '2026-10-09T00:00:00.000Z', { partial: true });
    h.env.fetch = async () => ({ items: [partial], report: { scanned: 1, skips: [], complete: true } });
    const whole = slackThread('C1', T, 'q?\nbob: agreed (edited)\ncarol: ship it', '2026-10-09T00:00:00.000Z');
    const fetchWhole = vi.fn(async () => whole);
    await syncSource('slack', { ...h.env, fetchWhole });
    const text = new DatabaseSync(h.dbPath).prepare('SELECT summary FROM decisions').get() as { summary: string };
    expect(text.summary).toBe('[#eng] Thread:\nq?\nbob: agreed (edited)\ncarol: ship it');
    expect(fetchWhole).toHaveBeenCalledTimes(1);
  });

  it('a whole read that is itself partial, or fails, falls back to the append merge', async () => {
    setup();
    h.env.fetch = async () => ({ items: [slackThread('C1', T, 'q?\nbob: agreed', '2026-10-01T00:00:00.000Z')], report: { scanned: 1, skips: [], complete: true } });
    await syncSource('slack', h.env);
    const partial = slackThread('C1', T, 'carol: ship it', '2026-10-09T00:00:00.000Z', { partial: true });
    h.env.fetch = async () => ({ items: [partial], report: { scanned: 1, skips: [], complete: true } });
    await syncSource('slack', { ...h.env, fetchWhole: async () => ({ ...partial, partial: true }) });
    await syncSource('slack', { ...h.env, fetchWhole: async () => { throw new Error('net'); } });
    const text = new DatabaseSync(h.dbPath).prepare('SELECT summary FROM decisions').get() as { summary: string };
    expect(text.summary).toBe('[#eng] Thread:\nq?\nbob: agreed\ncarol: ship it');
  });
});
