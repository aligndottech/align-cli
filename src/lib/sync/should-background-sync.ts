/**
 * L6 (Decisions 8, 9, 23): the launch decision, pure. It reads nothing itself: the caller hands in
 * what `sync-summary.json` said, so the launch path opens no database, makes no network call and
 * loads no fetcher to decide. Every gate fails toward "do not start anything".
 */
import type { SummarySource, SyncSummary } from './summary-read.js';

/** Decision 23: at most one background read per source per 15 minutes. One constant. */
export const SYNC_MIN_INTERVAL_MS = 15 * 60_000;
/** The child waits this long before its first request, so it does not compete with the agent's own start-up. */
export const BACKGROUND_LAUNCH_DELAY_SECONDS = 20;
/** The "reconnect this source" line is shown at most this often. */
export const REAUTH_LINE_INTERVAL_MS = 24 * 3_600_000;

/** What reaches argv. The summary is a file on disk, so an id is checked before it can be read as a flag. */
const SAFE_SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface BackgroundSyncGates {
  isTty: boolean;
  /** Already inside a launched agent (ALIGN_WRAPPED). */
  wrapped: boolean;
  /** ALIGN_NO_SYNC. */
  noSync: boolean;
  ci: boolean;
  /** `align sync --off`. */
  disabled: boolean;
  summary: SyncSummary | undefined;
  now: number;
}

export interface BackgroundSyncInput extends BackgroundSyncGates {
  minIntervalMs: number;
  /** Sources with a sync or a backfill running right now. */
  busy?: ReadonlySet<string>;
}

function gatesClosed(i: BackgroundSyncGates): boolean {
  return !i.isTty || i.wrapped || i.noSync || i.ci || i.disabled || !i.summary;
}

function parsed(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** The latest moment this source was tried, or undefined when no readable timestamp exists. */
function lastTried(s: SummarySource): number | undefined {
  const stamps = [parsed(s.lastSuccessAt), parsed(s.lastAttemptAt)].filter((t): t is number => t !== undefined);
  return stamps.length === 0 ? undefined : Math.max(...stamps);
}

export function shouldBackgroundSync(i: BackgroundSyncInput): string[] {
  if (gatesClosed(i)) return [];
  const due = new Set<string>();
  for (const s of i.summary!.sources) {
    if (!s.backgroundEligible || s.status === 'needs_reauth') continue;
    if (!SAFE_SOURCE_ID.test(s.id) || i.busy?.has(s.id)) continue;
    const tried = lastTried(s);
    // No readable timestamp, or one in the future (a clock that moved back): stale, never fresh.
    const age = tried === undefined ? Number.POSITIVE_INFINITY : i.now - tried;
    if (age < 0 || age >= i.minIntervalMs) due.add(s.id);
  }
  return [...due];
}

/** Eligible sources whose token stopped working, when the "reconnect" line is due. Same gates as the spawn. */
export function reauthSources(i: BackgroundSyncGates & { lastShownAt: string | undefined; intervalMs: number }): string[] {
  if (gatesClosed(i)) return [];
  const shown = parsed(i.lastShownAt);
  if (shown !== undefined && i.now - shown >= 0 && i.now - shown < i.intervalMs) return [];
  return [...new Set(i.summary!.sources.filter((s) => s.backgroundEligible && s.status === 'needs_reauth' && SAFE_SOURCE_ID.test(s.id)).map((s) => s.id))];
}
