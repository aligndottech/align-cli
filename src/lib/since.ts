/**
 * L3: the ONE parser for how far back an import reads. `align connect --since` and the MCP
 * tool `align_backfill` both call it, so the two surfaces cannot accept different spellings
 * of the same window (code-style.md: two readers of one format must agree).
 *
 * Accepted: `Nd`, `Nw`, `Nm` (a month is 30.4 days, rounded), `Ny`, and `all`. Anything else
 * is a SinceError: a window the user did not mean is worse than a refusal, because the
 * report would still say the read was complete.
 */
import { type SourceId, SYNC_CEILINGS, SYNC_TIME_BUDGET_MS, SYNC_WINDOW_DEFAULT_DAYS } from './import-defaults.js';

export const ACCEPTED_SINCE_FORMS = '30d, 2w, 6m, 1y or all';

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.4;
const DAYS_PER_UNIT = { d: 1, w: 7, m: MONTH_DAYS, y: 365 } as const;
// The SDK refuses a window that starts before 1970 (a `shape` skip, nothing read). Refusing
// it here turns that into a message naming the accepted forms instead of a skip line.
const EPOCH_MS = Date.UTC(1970, 0, 1);

export class SinceError extends Error {
  constructor(raw: string, why: string) {
    // Cut: a pasted secret in the wrong field must not ride along into an error transcript.
    super(`Cannot read "${raw.slice(0, 16)}" as how far back to look: ${why}. Use ${ACCEPTED_SINCE_FORMS}.`);
    this.name = 'SinceError';
  }
}

export interface SyncWindow {
  /** Days back from now. Absent for `all`. */
  days?: number;
  /** ISO-8601 UTC lower bound for the SDK's `since`. Absent for `all`: only the ceiling applies. */
  since?: string;
}

/** `undefined` means the flag was not passed: the plan default applies. */
export function parseSince(raw: string | undefined, now: Date = new Date()): SyncWindow {
  if (raw === undefined) return windowOfDays(SYNC_WINDOW_DEFAULT_DAYS, now);
  const text = raw.trim().toLowerCase();
  if (text === 'all') return {};
  const m = /^(\d+)([dwmy])$/.exec(text);
  if (!m) throw new SinceError(raw, 'it is not a whole number followed by d, w, m or y');
  const days = Math.round(Number(m[1]) * DAYS_PER_UNIT[m[2] as keyof typeof DAYS_PER_UNIT]);
  if (days < 1) throw new SinceError(raw, 'it is not a positive length of time');
  if (now.getTime() - days * DAY_MS < EPOCH_MS) throw new SinceError(raw, 'it reaches back before 1970');
  return windowOfDays(days, now);
}

function windowOfDays(days: number, now: Date): SyncWindow {
  return { days, since: new Date(now.getTime() - days * DAY_MS).toISOString() };
}

/**
 * The phrase the capture report prints. Exact: "the last 6 months" only for a window that IS
 * what `6m` parses to (182 days). The default is 180 days and reads "the last 180 days", so two
 * different reads never share a label. A month or year label needs the day count to be exactly
 * what that many months or years parse to; anything else is said in days.
 */
export function windowLabel(days: number | undefined): string {
  if (days === undefined) return 'all the history the ceiling allowed';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  // Years first: 3y is 1095 days, which 36 months (1094) does not round-trip to.
  if (days % 365 === 0) return `the last ${plural(days / 365, 'year')}`;
  const months = Math.round(days / MONTH_DAYS);
  if (months >= 2 && Math.round(months * MONTH_DAYS) === days) return `the last ${plural(months, 'month')}`;
  return `the last ${plural(days, 'day')}`;
}

/**
 * The options every windowed fetch gets: this source's ceiling, the shared time budget and the
 * window's lower bound. `since` is OMITTED for `all`, never set to undefined, so the SDK sees no
 * bound at all. The one reader of SYNC_CEILINGS for a fetch (import-defaults.test.ts pins it).
 */
export function fetchWindow(id: SourceId, window: SyncWindow): { limit: number; timeBudgetMs: number; since?: string } {
  return {
    limit: SYNC_CEILINGS[id],
    timeBudgetMs: SYNC_TIME_BUDGET_MS,
    ...(window.since !== undefined ? { since: window.since } : {}),
  };
}
