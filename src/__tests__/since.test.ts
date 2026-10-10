import { describe, expect, it } from 'vitest';
import { ACCEPTED_SINCE_FORMS, fetchWindow, parseSince, SinceError, windowLabel } from '../lib/since.js';
import { SYNC_CEILINGS, SYNC_TIME_BUDGET_MS, SYNC_WINDOW_DEFAULT_DAYS } from '../lib/import-defaults.js';

/**
 * L3: ONE duration parser for `align connect --since` and the MCP tool `align_backfill`.
 * Two readers of one format must agree (code-style.md), so both call this and nothing else.
 */
const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;

describe('parseSince: durations', () => {
  it.each([
    ['30d', 30],
    ['45d', 45],
    ['2w', 14],
    ['3w', 21],
    ['6m', 182], // months are 30.4 days, rounded: 182.4
    ['1m', 30],
    ['12m', 365], // 364.8
    ['1y', 365],
    ['2y', 730],
  ])('%s is %i days back from now', (raw, days) => {
    const w = parseSince(raw, NOW);
    expect(w.days).toBe(days);
    expect(w.since).toBe(new Date(NOW.getTime() - days * DAY).toISOString());
  });

  it('defaults to the plan window (180 days) when nothing is passed', () => {
    const w = parseSince(undefined, NOW);
    expect(w.days).toBe(SYNC_WINDOW_DEFAULT_DAYS);
    expect(w.days).toBe(180);
    expect(w.since).toBe('2026-04-13T12:00:00.000Z');
  });

  it('accepts upper case and surrounding spaces, because a person typed it', () => {
    expect(parseSince(' 30D ', NOW).days).toBe(30);
    expect(parseSince('1Y', NOW).days).toBe(365);
  });

  it('"all" means no start date at all, so only the ceiling applies', () => {
    const w = parseSince('all', NOW);
    expect(w.since).toBeUndefined();
    expect(w.days).toBeUndefined();
    expect(parseSince('ALL', NOW).since).toBeUndefined();
  });
});

describe('parseSince: everything else is refused, naming the accepted forms', () => {
  it.each(['6x', '-3d', '', '   ', '0d', '0m', '1.5y', '6 m', 'd', 'm6', '180', '2026-01-01', '1d2h', 'forever', '++3d'])(
    '%j throws SinceError',
    (raw) => {
      expect(() => parseSince(raw, NOW)).toThrow(SinceError);
      try {
        parseSince(raw, NOW);
      } catch (e) {
        expect((e as Error).message).toContain(ACCEPTED_SINCE_FORMS);
      }
    },
  );

  it('refuses a window that starts before 1970, which the SDK would refuse and report as a shape skip', () => {
    expect(() => parseSince('60y', NOW)).toThrow(SinceError);
    expect(() => parseSince('56y', NOW)).not.toThrow(); // 1970-10: still inside the SDK's range
  });

  it('names the accepted forms in words a person can act on', () => {
    expect(ACCEPTED_SINCE_FORMS).toBe('30d, 2w, 6m, 1y or all');
  });
});

describe('windowLabel: the phrase the report prints', () => {
  it.each([
    [180, 'the last 6 months'],
    [182, 'the last 6 months'],
    [30, 'the last 30 days'],
    [14, 'the last 14 days'],
    [365, 'the last 1 year'],
    [730, 'the last 2 years'],
    [90, 'the last 3 months'],
    [1, 'the last 1 day'],
  ])('%i days reads "%s"', (days, label) => {
    expect(windowLabel(days)).toBe(label);
  });

  it('has a phrase for no window', () => {
    expect(windowLabel(undefined)).toBe('all the history the ceiling allowed');
  });
});

describe('fetchWindow: the one place a window becomes fetcher options', () => {
  it.each(Object.keys(SYNC_CEILINGS) as Array<keyof typeof SYNC_CEILINGS>)('%s reads its ceiling, the shared budget and the window', (id) => {
    const w = parseSince('30d', NOW);
    expect(fetchWindow(id, w)).toEqual({ limit: SYNC_CEILINGS[id], timeBudgetMs: SYNC_TIME_BUDGET_MS, since: w.since });
  });

  it('with "all" there is no since key at all, so the SDK reads no lower bound (an undefined since is still a key)', () => {
    const opts = fetchWindow('github', parseSince('all', NOW));
    expect(opts).toEqual({ limit: 3_000, timeBudgetMs: 480_000 });
    expect('since' in opts).toBe(false);
  });

  it('two different windows give two different since values (the table is not a constant)', () => {
    expect(fetchWindow('jira', parseSince('1y', NOW)).since).not.toBe(fetchWindow('jira', parseSince('2w', NOW)).since);
  });
});
