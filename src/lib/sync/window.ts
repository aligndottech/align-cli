/**
 * L5: the pure decisions of an incremental sync - which window to read next and where the
 * watermark stands after a run. No database, no clock of its own, no network.
 *
 * The watermark is the vendor's own `updated_at` (Decision 4), taken from the SDK's report, and
 * it moves only on a COMPLETE read that carried one. Anything else leaves it where it was: a
 * watermark that moved past data nobody read loses that data for good, while one that stays put
 * costs a re-read the unchanged-skip makes cheap.
 */
import { SYNC_WINDOW_DEFAULT_DAYS } from '../import-defaults.js';

/** Each run reads from a day before the watermark, so an item edited between two runs while the
 *  vendor was behind on its own indexing is not missed. */
export const OVERLAP_DAYS = 1;
/** A hole that ended this many consecutive runs the same way is called persistent. */
export const PERSISTENT_HOLE_RUNS = 5;
const DAY_MS = 86_400_000;

/** The slice of a `source_sync` row the next-window decision reads. */
export interface WindowState {
  /** Lower bound the user asked for. `null` on an EXISTING row means "all" (L3's record of `since: all`). */
  window_since: string | null;
  high_water: string | null;
  pending_until: string | null;
  /** Consecutive runs that ended on the same hole. While it is above zero the re-read is bounded (see nextWindow). */
  hole_streak?: number;
}

function parse(iso: string | null | undefined): number | undefined {
  if (iso === null || iso === undefined) return undefined;
  const ms = Date.parse(iso);
  // NaN compares false with everything, in both directions (verification.md): refuse it here.
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The window a NEW scope row starts with: the one the person asked for on this source, which is the `yours` row's (L3 records
 * `since: all` as NULL there, and "all" stays all). A source with no `yours` row yet starts at the default window.
 * The one writer: the sync's first run on a scope and a scope change from `align connect` or `align_scope` both call it.
 */
export function inheritedWindowSince(rows: ReadonlyArray<{ scope_key: string; window_since: string | null }>, now: Date): string | null {
  const yours = rows.find((r) => r.scope_key === 'yours');
  return yours ? yours.window_since : nextWindow(undefined, now).since!;
}

export function minusDays(iso: string, days: number): string {
  const ms = parse(iso);
  if (ms === undefined) throw new Error(`Cannot read "${iso.slice(0, 40)}" as a date.`);
  return new Date(ms - days * DAY_MS).toISOString();
}

/**
 * What the next run asks the vendor for.
 * - No row: the default window back from now (the first sync of a source).
 * - A high_water: one overlap day before it. Otherwise the row's own window_since, untouched.
 * - A pending_until: also an `until` there, so a run that a ceiling cut finishes the OLDER part.
 * An unparseable stored stamp reads as absent, which can only widen the read.
 */
export function nextWindow(s: WindowState | undefined, now: Date): { since?: string; until?: string } {
  if (s === undefined) return { since: new Date(now.getTime() - SYNC_WINDOW_DEFAULT_DAYS * DAY_MS).toISOString() };
  // A stored watermark from the future (written by an older build, or by a clock that was wrong) is
  // repaired by ignoring it: the read widens to the window, and the run's own result replaces it.
  const hw = plausible(s.high_water ?? undefined, now) === undefined ? undefined : s.high_water!;
  const floor = hw !== undefined ? minusDays(hw, OVERLAP_DAYS) : parse(s.window_since) === undefined ? undefined : s.window_since!;
  const until = parse(s.pending_until) === undefined ? undefined : s.pending_until!;
  // A hole that keeps coming back keeps the watermark where it was, so the re-read would grow every day, and a source that
  // reads more each time is more likely to hit its budget again. Bound it to the default window while a hole is open.
  const bound = (s.hole_streak ?? 0) > 0 ? new Date(now.getTime() - SYNC_WINDOW_DEFAULT_DAYS * DAY_MS).toISOString() : undefined;
  const since = bound !== undefined && (floor === undefined || Date.parse(floor) < Date.parse(bound)) ? bound : floor;
  return { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) };
}

export interface RunFinish {
  complete: boolean;
  /**
   * Incomplete BECAUSE the listing was cut in date order (a vendor ceiling, an item ceiling or a
   * time budget on a newest-first listing): everything newer than `oldestReached` was read, so the
   * next run can finish the older part with `until`. Any other incompleteness is a HOLE (a channel
   * that would not open, a refused repo, a thread read that hit its page cap): no date line
   * separates read from unread, so no `until` is set and the next run re-reads from the watermark.
   */
  cut?: boolean;
  /** This hole has now come back often enough (see PERSISTENT_HOLE_RUNS) that the watermark stops waiting for it. */
  persistent?: boolean;
  highWater?: string;
  oldestReached?: string;
  /** The newest `updated_at` stored for this source across the whole cycle, for the final run of
   *  a pending cycle: its own highWater is clamped to `until` and would pull the mark back. */
  cycleNewest?: string;
  /** When given, a stamp more than a day AFTER it is ignored: a watermark in the future would
   *  hide every later change from every later run. */
  now?: Date;
}

export function later(a: string | null | undefined, b: string | null | undefined): string | null {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined) return pb === undefined ? null : b!;
  if (pb === undefined) return a!;
  return pb > pa ? b! : a!;
}

function earlier(a: string | null | undefined, b: string | null | undefined): string | null {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined) return pb === undefined ? null : b!;
  if (pb === undefined) return a!;
  return pb < pa ? b! : a!;
}

export function plausible(iso: string | undefined, now: Date | undefined): string | undefined {
  const t = parse(iso);
  if (t === undefined) return undefined;
  return now !== undefined && t > now.getTime() + DAY_MS ? undefined : iso;
}

export function finishRun(
  prev: Pick<WindowState, 'high_water' | 'pending_until'>,
  r: RunFinish,
): { high_water: string | null; pending_until: string | null; status: 'ok' | 'partial' } {
  const prevHigh = plausible(prev.high_water ?? undefined, r.now) === undefined ? null : prev.high_water;
  if (r.complete) {
    return { high_water: later(later(prevHigh, plausible(r.highWater, r.now)), plausible(r.cycleNewest, r.now)), pending_until: null, status: 'ok' };
  }
  if (r.persistent === true) {
    // The other streams are read and committed; only the hole is not. Say so in the status, and move on.
    return { high_water: later(later(prevHigh, plausible(r.highWater, r.now)), plausible(r.cycleNewest, r.now)), pending_until: null, status: 'partial' };
  }
  if (r.cut === true) return { high_water: prevHigh, pending_until: earlier(prev.pending_until, r.oldestReached), status: 'partial' };
  return { high_water: prevHigh, pending_until: null, status: 'partial' };
}

/** Oldest first. A kill after batch N then leaves every older item committed, so a watermark equal
 *  to the newest committed stamp never sits above an unread one. Items with no stamp lead. */
export function ascendingByUpdated<T extends { updated_at?: string }>(items: readonly T[]): T[] {
  const stamp = (i: T): number => parse(i.updated_at) ?? Number.NEGATIVE_INFINITY;
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => (stamp(a.item) - stamp(b.item) || a.index - b.index) || 0)
    .map((e) => e.item);
}

export function newestUpdated(items: ReadonlyArray<{ updated_at?: string }>, now?: Date): string | undefined {
  let best: string | undefined;
  for (const i of items) if (plausible(i.updated_at, now) !== undefined) best = later(best, i.updated_at) ?? best;
  return best;
}
