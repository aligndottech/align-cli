import { describe, expect, it } from 'vitest';
import { ascendingByUpdated, finishRun, minusDays, newestUpdated, nextWindow, OVERLAP_DAYS } from '../lib/sync/window.js';
import { SYNC_WINDOW_DEFAULT_DAYS } from '../lib/import-defaults.js';

/**
 * L5 Test List (window and watermark; pure):
 * - Given high_water H and a complete run, the next run's since is H minus 1 day, and high_water advances to the report's highWater.
 * - Given an incomplete run, high_water does not move and pending_until is set.
 * - Given pending_until P, the next run fetches until = P. Given that run completes, pending clears and high_water advances.
 * - A cycle's newest item survives the final, clamped run (it must not pull high_water back).
 * - Never advance without a highWater from the report; unparseable stored stamps read as absent (more reading, never less).
 */
const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('nextWindow', () => {
  it('no row at all: the default window back from now, no upper bound', () => {
    expect(nextWindow(undefined, NOW)).toEqual({ since: ago(SYNC_WINDOW_DEFAULT_DAYS) });
  });

  it('a row with a high_water: since is H minus the overlap day (two examples)', () => {
    expect(OVERLAP_DAYS).toBe(1);
    expect(nextWindow({ window_since: ago(180), high_water: '2026-10-09T10:00:00.000Z', pending_until: null }, NOW))
      .toEqual({ since: '2026-10-08T10:00:00.000Z' });
    expect(nextWindow({ window_since: ago(180), high_water: '2026-09-01T00:00:00.000Z', pending_until: null }, NOW))
      .toEqual({ since: '2026-08-31T00:00:00.000Z' });
  });

  it('a row with no high_water starts at its window_since exactly (no overlap day taken off a user-chosen bound)', () => {
    expect(nextWindow({ window_since: '2025-10-10T12:00:00.000Z', high_water: null, pending_until: null }, NOW))
      .toEqual({ since: '2025-10-10T12:00:00.000Z' });
  });

  it('an existing row whose window_since is null is "all": no lower bound at all', () => {
    expect(nextWindow({ window_since: null, high_water: null, pending_until: null }, NOW)).toEqual({});
    expect(nextWindow({ window_since: null, high_water: '2026-10-09T00:00:00.000Z', pending_until: null }, NOW))
      .toEqual({ since: '2026-10-08T00:00:00.000Z' });
  });

  it('pending_until P: the read stops at P (until) and resumes from the same lower bound', () => {
    expect(nextWindow({ window_since: ago(180), high_water: null, pending_until: '2026-08-01T00:00:00.000Z' }, NOW))
      .toEqual({ since: ago(180), until: '2026-08-01T00:00:00.000Z' });
    expect(nextWindow({ window_since: ago(180), high_water: '2026-10-01T00:00:00.000Z', pending_until: '2026-10-05T00:00:00.000Z' }, NOW))
      .toEqual({ since: '2026-09-30T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' });
  });

  it('an unparseable stored stamp reads as absent: the read widens, it never narrows or throws', () => {
    expect(nextWindow({ window_since: ago(180), high_water: 'not-a-date', pending_until: 'also-not' }, NOW))
      .toEqual({ since: ago(180) });
  });
});

describe('minusDays', () => {
  it('subtracts whole days from an ISO instant', () => {
    expect(minusDays('2026-10-10T12:00:00.000Z', 1)).toBe('2026-10-09T12:00:00.000Z');
    expect(minusDays('2026-10-10T12:00:00.000Z', 30)).toBe('2026-09-10T12:00:00.000Z');
  });
  it('throws on a stamp it cannot read (NaN would compare false with everything)', () => {
    expect(() => minusDays('nope', 1)).toThrow(/nope/);
  });
});

describe('finishRun', () => {
  const prev = { high_water: '2026-10-01T00:00:00.000Z', pending_until: null as string | null };

  it('complete with a highWater: high_water advances to it and pending clears', () => {
    expect(finishRun(prev, { complete: true, highWater: '2026-10-09T00:00:00.000Z' }))
      .toEqual({ high_water: '2026-10-09T00:00:00.000Z', pending_until: null, status: 'ok' });
  });

  it('complete, a second example from a first-ever run (no previous high_water)', () => {
    expect(finishRun({ high_water: null, pending_until: null }, { complete: true, highWater: '2026-09-09T00:00:00.000Z' }))
      .toEqual({ high_water: '2026-09-09T00:00:00.000Z', pending_until: null, status: 'ok' });
  });

  it('high_water never moves back, even when the report is older than what is stored', () => {
    expect(finishRun(prev, { complete: true, highWater: '2026-09-01T00:00:00.000Z' }).high_water).toBe('2026-10-01T00:00:00.000Z');
  });

  it('complete but the report has no highWater: nothing advances (an empty window proves nothing about time)', () => {
    expect(finishRun(prev, { complete: true })).toEqual({ high_water: prev.high_water, pending_until: null, status: 'ok' });
    expect(finishRun({ high_water: null, pending_until: null }, { complete: true }).high_water).toBeNull();
  });

  it('incomplete: high_water does not move and pending_until is the oldest item seen', () => {
    expect(finishRun(prev, { complete: false, highWater: '2026-10-09T00:00:00.000Z', oldestReached: '2026-09-15T00:00:00.000Z' }))
      .toEqual({ high_water: prev.high_water, pending_until: '2026-09-15T00:00:00.000Z', status: 'partial' });
  });

  it('incomplete again inside a cycle: pending_until only moves DOWN (never re-reads what a run already covered)', () => {
    const mid = { high_water: prev.high_water, pending_until: '2026-09-15T00:00:00.000Z' };
    expect(finishRun(mid, { complete: false, oldestReached: '2026-09-01T00:00:00.000Z' }).pending_until).toBe('2026-09-01T00:00:00.000Z');
    expect(finishRun(mid, { complete: false, oldestReached: '2026-09-20T00:00:00.000Z' }).pending_until).toBe('2026-09-15T00:00:00.000Z');
  });

  it('incomplete with nothing seen keeps the pending bound it had', () => {
    const mid = { high_water: null, pending_until: '2026-09-15T00:00:00.000Z' };
    expect(finishRun(mid, { complete: false })).toEqual({ high_water: null, pending_until: '2026-09-15T00:00:00.000Z', status: 'partial' });
  });

  it('the final run of a cycle reports a highWater clamped to its until; the cycle newest keeps high_water at the true top', () => {
    const mid = { high_water: null, pending_until: '2026-09-15T00:00:00.000Z' };
    const done = finishRun(mid, { complete: true, highWater: '2026-09-14T00:00:00.000Z', cycleNewest: '2026-10-09T00:00:00.000Z' });
    expect(done).toEqual({ high_water: '2026-10-09T00:00:00.000Z', pending_until: null, status: 'ok' });
  });

  it('a stamp from the future (a vendor bug, a wrong clock) never becomes the watermark', () => {
    const future = '2026-12-31T00:00:00.000Z';
    expect(finishRun(prev, { complete: true, highWater: future, now: NOW }).high_water).toBe(prev.high_water);
    expect(finishRun(prev, { complete: true, highWater: '2026-10-09T00:00:00.000Z', cycleNewest: future, now: NOW }).high_water).toBe('2026-10-09T00:00:00.000Z');
    // within a day of now is allowed (clock skew), and without `now` nothing is judged
    expect(finishRun(prev, { complete: true, highWater: '2026-10-11T00:00:00.000Z', now: NOW }).high_water).toBe('2026-10-11T00:00:00.000Z');
    expect(finishRun(prev, { complete: true, highWater: future }).high_water).toBe(future);
  });

  it('an unparseable report stamp is ignored, not trusted', () => {
    expect(finishRun(prev, { complete: true, highWater: 'garbage' }).high_water).toBe(prev.high_water);
  });
});

describe('batch order', () => {
  const it1 = { updated_at: '2026-10-03T00:00:00.000Z', id: 'c' };
  const it2 = { updated_at: '2026-10-01T00:00:00.000Z', id: 'a' };
  const it3 = { updated_at: '2026-10-02T00:00:00.000Z', id: 'b' };
  const bare = { id: 'z' };

  it('oldest first, so a kill leaves every older item committed; items with no stamp lead and stay in order', () => {
    expect(ascendingByUpdated([it1, bare, it2, it3]).map((i) => i.id)).toEqual(['z', 'a', 'b', 'c']);
  });
  it('does not mutate its input', () => {
    const input = [it1, it2];
    ascendingByUpdated(input);
    expect(input.map((i) => i.id)).toEqual(['c', 'a']);
  });
  it('newestUpdated is the latest stamp of the batch, undefined when none carries one', () => {
    expect(newestUpdated([it2, it1, it3, bare])).toBe('2026-10-03T00:00:00.000Z');
    expect(newestUpdated([bare])).toBeUndefined();
    expect(newestUpdated([])).toBeUndefined();
  });
});
