import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { FetcherItem } from '@aligndottech/connector-core';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (t: string) => { await new Promise<void>((r) => setImmediate(r)); const v = new Float32Array(384).fill(0.01); v[t.length % 7] = 1; return v; }),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { collectStatus, renderStatus } from '../lib/sync/status.js';
import { runSync } from '../lib/sync/run-all.js';
import { syncSource } from '../lib/sync/run-source.js';
import { readRows } from '../lib/sync/sync-state.js';
import { PERSISTENT_HOLE_RUNS } from '../lib/sync/window.js';
import { type Harness, harness, slackThread } from './helpers/sync-env.js';

/**
 * L5 second review. A HOLE is an incomplete read with no date line (a space, a channel, a second query that was never
 * reached); a CUT is one newest-first listing that stopped. Treating a hole as a cut resumes "below the oldest item" and
 * skips the gap for good. These scenarios run a window-aware fake vendor and look for items that never arrive.
 *  H1  a multi-stream source whose budget ends before one stream: the gap is read on the next run.
 *  H2  a cut-kind skip BESIDE an error skip is a hole.   Matrix: every skip kind x every source.
 *  H4  a hole that comes back is bounded, named, and after five runs stops holding the watermark back.
 *  H5  the re-link queue has its own budget when a source spent all of its own.
 *  F   whole-thread re-reads: three at a time, inside a time budget, every fallback counted.
 */
vi.setConfig({ testTimeout: 60_000 });
let h: Harness;
afterEach(() => h?.cleanup());
const DAY = 86_400_000;
const START = '2026-10-10T12:00:00.000Z';
const item = (plat: string, space: string, n: number, updated: string): FetcherItem => ({
  source_url: `https://x.atlassian.net/wiki/spaces/${space}/pages/${n}`, platform: plat, title: `${space}-${n}`, raw_text: `page ${space} ${n}`, created_at: updated, updated_at: updated,
});
const titles = (): string[] => { const db = new DatabaseSync(h.dbPath); try { return (db.prepare('SELECT title FROM decisions ORDER BY title').all() as Array<{ title: string }>).map((r) => r.title); } finally { db.close(); } };
const inWin = (xs: FetcherItem[], w: { since?: string; until?: string }) => xs.filter((i) => (!w.since || i.updated_at! >= w.since) && (!w.until || i.updated_at! < w.until));
const rep = (xs: FetcherItem[], extra: Record<string, unknown>) => { const s = xs.map((i) => i.updated_at!).sort(); return { scanned: xs.length, ...(s.length ? { highWater: s.at(-1), oldestReached: s[0] } : {}), ...extra }; };

describe('H1: a hole is not a cut', () => {
  // Space A reaches back to May; space B (Jul) sits INSIDE A's range. A budget that stops the walk before B leaves B unread.
  const A = [item('confluence', 'A', 1, '2026-05-01T00:00:00Z'), item('confluence', 'A', 2, '2026-10-01T00:00:00Z')];
  const B = [item('confluence', 'B', 1, '2026-07-01T00:00:00Z')];

  async function scenario(source: string): Promise<void> {
    let clock = new Date(START);
    h = harness({ now: () => clock });
    let budget = true;
    h.env.fetch = async (_s, _t, win) => {
      const a = inWin(A, win); const b = inWin(B, win);
      if (budget && b.length) return { items: a, report: rep(a, { complete: false, skips: [{ kind: 'time_budget', count: 1, detail: 'spaces not read' }] }) } as never;
      return { items: [...a, ...b], report: rep([...a, ...b], { complete: true, skips: [] }) } as never;
    };
    await syncSource(source, h.env);
    budget = false;
    for (let d = 1; d <= 3; d++) { clock = new Date(clock.getTime() + DAY); await syncSource(source, h.env); }
  }

  it('confluence (one listing per space): the next run reads space B', async () => {
    await scenario('confluence');
    expect(titles()).toContain('B-1');
    expect(readRows(h.dbPath, 'confluence')[0]!.pending_until).toBeNull();
  });

  it.each(['github', 'linear', 'teams', 'slack', 'zoom'])('%s: another source with several streams or windows: the same, space B is read', async (source) => {
    await scenario(source);
    expect(titles()).toContain('B-1');
  });

  it('the control: on jira, ONE newest-first listing, the same report IS a cut and the next run reads below the oldest item', async () => {
    let clock = new Date(START);
    h = harness({ now: () => clock });
    const wins: Array<{ since?: string; until?: string }> = [];
    h.env.fetch = async (_s, _t, win) => { wins.push(win); const a = inWin([...A, ...B], win).slice(-2); return { items: a, report: rep(a, { complete: false, skips: [{ kind: 'time_budget', count: 1, detail: 'issue read stopped; older issues not read' }] }) } as never; };
    await syncSource('jira', h.env);
    clock = new Date(clock.getTime() + DAY);
    await syncSource('jira', h.env);
    expect(wins[1]!.until).toBeDefined();
  });
});

describe('H2: any hole-kind skip beside a cut-kind one makes the run a hole', () => {
  it('a failed search page beside a ceiling: the failed page\'s newer item is read next time', async () => {
    let clock = new Date(START);
    h = harness({ now: () => clock });
    const all = [item('jira', 'g', 1, '2026-06-01T00:00:00Z'), item('jira', 'g', 2, '2026-09-01T00:00:00Z'), item('jira', 'g', 3, '2026-10-05T00:00:00Z')];
    let first = true;
    h.env.fetch = async (_s, _t, win) => {
      const w = inWin(all, win);
      if (first) { first = false; const got = w.filter((i) => i.title !== 'g-2'); return { items: got, report: rep(got, { complete: false, skips: [{ kind: 'error', count: 1, detail: 'search page failed (502)' }, { kind: 'time_budget', count: 1, detail: 'older not read' }] }) } as never; }
      return { items: w, report: rep(w, { complete: true, skips: [] }) } as never;
    };
    await syncSource('jira', h.env);
    expect(readRows(h.dbPath, 'jira')[0]!.pending_until).toBeNull();
    for (let d = 1; d <= 3; d++) { clock = new Date(clock.getTime() + DAY); await syncSource('jira', h.env); }
    expect(titles()).toContain('g-2');
  });

  // The independent statement of the rule: which skip kinds a source may carry and STILL be a cut.
  const ALLOWED: Record<string, string[]> = { jira: ['time_budget', 'page_cap'], notion: ['time_budget'], gitlab: ['time_budget'] };
  const KINDS = ['error', 'auth', 'page_cap', 'time_budget', 'vendor_cap', 'pending', 'shape'];
  const SOURCES = ['jira', 'notion', 'gitlab', 'github', 'linear', 'confluence', 'teams', 'slack', 'zoom'];
  const cases = SOURCES.flatMap((s) => KINDS.flatMap((k) => [[s, [k]], ...(k !== 'time_budget' ? [[s, [k, 'time_budget']]] : [])] as Array<[string, string[]]>));

  it.each(cases)('%s with skips %j', async (source, kinds) => {
    h = harness();
    const one = [item(source, 'x', 1, '2026-10-05T00:00:00Z')];
    h.env.fetch = async () => ({ items: one, report: rep(one, { complete: false, skips: kinds.map((k) => ({ kind: k, count: 1, detail: `a ${k} skip` })) }) }) as never;
    await syncSource(source, h.env);
    const allowed = ALLOWED[source];
    const expectCut = allowed !== undefined && kinds.every((k) => k === 'shape' || allowed.includes(k));
    expect(readRows(h.dbPath, source)[0]!.pending_until !== null).toBe(expectCut);
  });

  it('a single-listing source that hit its ITEM ceiling emits no skip at all: that is a cut', async () => {
    h = harness();
    const one = [item('jira', 'x', 1, '2026-10-05T00:00:00Z')];
    h.env.fetch = async () => ({ items: one, report: rep(one, { complete: false, skips: [] }) }) as never;
    await syncSource('jira', h.env);
    expect(readRows(h.dbPath, 'jira')[0]!.pending_until).toBe('2026-10-05T00:00:00Z');
  });
});

describe('H4: a hole that comes back', () => {
  const hole = { kind: 'error', count: 1, detail: 'channels the token could not read' };
  async function daily(days: number, clockOf: { v: Date }): Promise<Array<{ since?: string }>> {
    const wins: Array<{ since?: string }> = [];
    h.env.fetch = async (_s, _t, win) => {
      wins.push(win);
      const fresh = item('slack', 'C1', Math.floor(clockOf.v.getTime() / DAY), new Date(clockOf.v.getTime() - 3_600_000).toISOString());
      return { items: [fresh], report: rep([fresh], { complete: false, skips: [hole] }) } as never;
    };
    for (let d = 0; d < days; d++) { await syncSource('slack', h.env); clockOf.v = new Date(clockOf.v.getTime() + DAY); }
    return wins;
  }

  it('the re-read never reaches back past the default window, however long the hole lasts (day 90 would have re-read 270 days)', async () => {
    const c = { v: new Date(START) };
    h = harness({ now: () => c.v });
    const wins = await daily(90, c);
    const last = wins.at(-1)!.since!;
    const nowAtLast = new Date(Date.parse(START) + 89 * DAY);
    expect(Date.parse(last)).toBeGreaterThanOrEqual(nowAtLast.getTime() - 180 * DAY);
  }, 300_000); // 90 daily syncs, each several commits: 6 s on Linux, 70 s on the Windows runner

  it('the same hole five runs in a row is called persistent: named in the status, and the watermark moves past it for the rest', async () => {
    const c = { v: new Date(START) };
    h = harness({ now: () => c.v });
    await daily(PERSISTENT_HOLE_RUNS - 1, c);
    expect(readRows(h.dbPath, 'slack')[0]).toMatchObject({ high_water: null, hole_streak: PERSISTENT_HOLE_RUNS - 1 });
    expect(collectStatus({ dbPath: h.dbPath, isConnected: () => true, syncRunning: () => false, backfill: () => null, backfillAlive: () => false }).sources.find((s) => s.id === 'slack')!.persistent_hole).toBeUndefined();
    await daily(1, c);
    const r = readRows(h.dbPath, 'slack')[0]!;
    expect(r.hole_streak).toBe(PERSISTENT_HOLE_RUNS);
    expect(r.high_water).not.toBeNull();
    const status = collectStatus({ dbPath: h.dbPath, isConnected: () => true, syncRunning: () => false, backfill: () => null, backfillAlive: () => false });
    expect(status.sources.find((s) => s.id === 'slack')!.persistent_hole).toContain('channels the token could not read');
    expect(renderStatus(status)).toContain('persistent hole:');
    expect(r.status).toBe('partial'); // still honest: something is not being read
  });

  it('a different hole, or a clean run, starts the count again', async () => {
    const c = { v: new Date(START) };
    h = harness({ now: () => c.v });
    await daily(3, c);
    h.env.fetch = async () => ({ items: [], report: { scanned: 0, complete: false, skips: [{ kind: 'auth', count: 1, detail: 'a different problem' }] } }) as never;
    await syncSource('slack', h.env);
    expect(readRows(h.dbPath, 'slack')[0]!.hole_streak).toBe(1);
    h.env.fetch = async () => ({ items: [], report: { scanned: 0, complete: true, skips: [] } }) as never;
    await syncSource('slack', h.env);
    expect(readRows(h.dbPath, 'slack')[0]).toMatchObject({ hole_streak: 0, hole_sig: null, status: 'ok' });
  });

  it('digits in a hole\'s detail do not make it a new hole every run ("12 channels" then "11 channels" is one hole)', async () => {
    h = harness();
    let n = 12;
    h.env.fetch = async () => ({ items: [], report: { scanned: 0, complete: false, skips: [{ kind: 'error', count: n--, detail: `${n} channels the token could not read` }] } }) as never;
    for (let i = 0; i < 3; i++) await syncSource('slack', h.env);
    expect(readRows(h.dbPath, 'slack')[0]!.hole_streak).toBe(3);
  });
});

describe('H5: the re-link queue has its own budget', () => {
  it('a source that spent its whole 8 minutes still leaves the queue a minute: rows are linked and the run is not "timed out"', async () => {
    const c = { v: new Date(START) };
    h = harness({ now: () => c.v });
    const db = new DatabaseSync(h.dbPath);
    db.exec(`INSERT INTO decisions (id, title, summary, platform, source_url) VALUES ('x', 'x', 's', 'github', 'https://github.com/o/r/pull/5')`);
    db.close();
    const calls: number[] = [];
    (h.env.client as unknown as { relinkUnfinished: unknown }).relinkUnfinished = async (rows: unknown[]) => { calls.push(rows.length); return { linked: rows.length, embedded: 0, skipped: 0 }; };
    h.env.fetch = async () => { c.v = new Date(c.v.getTime() + 8 * 60_000); return { items: [], report: { scanned: 0, complete: false, skips: [{ kind: 'time_budget', count: 40, detail: 'channels not scanned' }] } } as never; };
    const r = await runSync(['slack'], h.env, { trigger: 'background' });
    expect(calls).toEqual([1]);
    expect(r.relink).toMatchObject({ timedOut: false });
  });
});

describe('F: whole-thread re-reads are bounded and counted', () => {
  const THREADS = Array.from({ length: 8 }, (_, i) => ({ ts: `17900000${String(10 + i)}.000100`, text: `q${i}?\nbob: agreed` }));
  async function seedThreads(): Promise<void> {
    h.env.fetch = async () => ({ items: THREADS.map((t, i) => slackThread('C1', t.ts, t.text, `2026-10-0${1 + (i % 5)}T00:00:00.000Z`)), report: { scanned: 8, skips: [], complete: true } }) as never;
    await syncSource('slack', h.env);
  }
  const partials = () => THREADS.map((t) => slackThread('C1', t.ts, 'carol: ship it', '2026-10-09T00:00:00.000Z', { partial: true }));

  it('never more than three whole-thread reads in flight', async () => {
    h = harness();
    await seedThreads();
    h.env.fetch = async () => ({ items: partials(), report: { scanned: 8, skips: [], complete: true } }) as never;
    let live = 0; let peak = 0;
    const fetchWhole = async (_p: string, _t: unknown, url: string) => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live -= 1;
      const t = THREADS.find((x) => url.endsWith(`p${x.ts.replace('.', '')}`))!;
      return slackThread('C1', t.ts, `${t.text}\ncarol: ship it`, '2026-10-09T00:00:00.000Z');
    };
    await syncSource('slack', { ...h.env, fetchWhole: fetchWhole as never });
    expect(peak).toBe(3);
  });

  it('a read that fails (a 429) falls back to the append merge AND is counted with its reason, not swallowed', async () => {
    h = harness();
    await seedThreads();
    h.env.fetch = async () => ({ items: partials(), report: { scanned: 8, skips: [], complete: true } }) as never;
    const out = await syncSource('slack', { ...h.env, fetchWhole: async () => { throw new Error('Slack rate limit: retry after 30 s'); } });
    const note = out.skips.find((s) => /kept as partial/.test(s.detail))!;
    expect(note).toMatchObject({ kind: 'shape', count: 8 });
    expect(note.detail).toContain('Slack rate limit');
    const db = new DatabaseSync(h.dbPath);
    try { expect((db.prepare('SELECT summary FROM decisions ORDER BY title').all() as Array<{ summary: string }>).every((r) => r.summary.endsWith('carol: ship it'))).toBe(true); } finally { db.close(); }
  });

  it('the pass has a time budget: once it is spent, the rest are merged, counted, and say why', async () => {
    const c = { v: new Date(START) };
    h = harness({ now: () => c.v });
    await seedThreads();
    h.env.fetch = async () => ({ items: partials(), report: { scanned: 8, skips: [], complete: true } }) as never;
    let reads = 0;
    const fetchWhole = async (_p: string, _t: unknown, url: string) => {
      reads += 1;
      c.v = new Date(c.v.getTime() + 40_000); // each read "takes" 40 s
      const t = THREADS.find((x) => url.endsWith(`p${x.ts.replace('.', '')}`))!;
      return slackThread('C1', t.ts, `${t.text}\ncarol: ship it`, '2026-10-09T00:00:00.000Z');
    };
    const out = await syncSource('slack', { ...h.env, fetchWhole: fetchWhole as never });
    expect(reads).toBeLessThan(8);
    const note = out.skips.find((s) => /kept as partial/.test(s.detail))!;
    expect(note.count).toBe(8 - reads);
    expect(note.detail).toContain('time allowed');
  });

  it('when every whole read works there is no note at all', async () => {
    h = harness();
    await seedThreads();
    h.env.fetch = async () => ({ items: partials(), report: { scanned: 8, skips: [], complete: true } }) as never;
    const out = await syncSource('slack', { ...h.env, fetchWhole: async (_p, _t, url) => { const t = THREADS.find((x) => url.endsWith(`p${x.ts.replace('.', '')}`))!; return slackThread('C1', t.ts, `${t.text}\ncarol: ship it`, '2026-10-09T00:00:00.000Z'); } });
    expect(out.skips.filter((s) => /kept as partial/.test(s.detail))).toEqual([]);
  });
});
