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

describe('windowLabel: the phrase the report prints, exact about the days', () => {
  // A label must not claim a length the window does not have: --since 6m is 182 days, the default
  // is 180, and "the last 6 months" for both made two different reads look identical.
  it.each([
    [180, 'the last 180 days'], // the default: NOT "6 months"
    [182, 'the last 6 months'], // --since 6m
    [30, 'the last 30 days'],
    [14, 'the last 14 days'],
    [365, 'the last 1 year'],
    [730, 'the last 2 years'],
    [1095, 'the last 3 years'], // 3y: round-trips exactly, so not "1095 days"
    [547, 'the last 18 months'], // 18m
    [61, 'the last 2 months'],
    [60, 'the last 60 days'], // not 2 months
    [90, 'the last 90 days'],
    [366, 'the last 366 days'], // not 1 year
    [1, 'the last 1 day'],
  ])('%i days reads "%s"', (days, label) => {
    expect(windowLabel(days)).toBe(label);
  });

  it('every spelling the parser accepts gets a label that is true of it', () => {
    for (const raw of ['1m', '2m', '6m', '11m', '12m', '13m', '18m', '1y', '2y', '3y', '10y', '10w', '45d']) {
      const days = parseSince(raw, NOW).days!;
      const label = windowLabel(days);
      const n = /last (\d+) (day|month|year)/.exec(label)!;
      const per = { day: 1, month: 30.4, year: 365 }[n[2] as 'day' | 'month' | 'year'];
      expect(Math.round(Number(n[1]) * per), `${raw} -> ${label}`).toBe(days);
    }
  });

  it('has a phrase for no window', () => {
    expect(windowLabel(undefined)).toBe('all the history the ceiling allowed');
  });
});

describe('what an error echoes back (a pasted secret must not ride along)', () => {
  it('cuts the echoed value to 16 characters', () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    try { parseSince(secret, NOW); } catch (e) {
      expect((e as Error).message).not.toContain(secret);
      expect((e as Error).message).toContain(secret.slice(0, 16));
      expect((e as Error).message).not.toContain(secret.slice(0, 17));
      return;
    }
    throw new Error('should have thrown');
  });

  it('leaves a short value whole', () => {
    expect(() => parseSince('6x', NOW)).toThrow('"6x"');
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
