/**
 * ALI-827: one place that turns a fetcher's read into a capture report, so a
 * connector-core that cannot report (0.5.0) and one that can (0.6.0, `fetchWithReport`)
 * differ in exactly one branch rather than in nine wrappers.
 *
 * With no report from the fetcher, the fallback says only what the CALLER can honestly
 * say: how many came back, and how many were asked for. It never guesses a reason -
 * "zoom returns at most 30" is a fact the fetcher owns, and stating it here would be a
 * second writer of it (code-style.md). With a report, the fetcher's own skips are carried
 * through verbatim: they are written for a person and the CLI prints them.
 */
import type { PersonalImportItem } from '../personal-import.js';

/** What a read could NOT reach, in the fetcher's own terms: a count and a measured
 *  reason, printed verbatim, so `detail` is written for a person. Owned here, by the
 *  producer; the renderer consumes it. */
export interface CaptureSkip {
  /** The SDK's kind (page_cap, time_budget, vendor_cap, shape, pending, error, auth), when the
   *  fetcher reported one. The renderer branches on it for one thing only: which skip stopped
   *  a windowed read. Any other kind is printed verbatim like the rest (the union grows). */
  kind?: string;
  /** How many source objects this covers. */
  count: number;
  /** One line printed after the count. */
  detail: string;
}

export interface CaptureFetchReport {
  /** Source objects examined before any filter, when the producer measured it (git, docs
   *  and every 0.6.0 SDK fetcher do). The fallback below cannot, and sets it to the
   *  returned count - so treat it as best-effort, never as a reliable pre-filter figure. */
  scanned: number;
  /** The cap the caller asked for, when it is worth saying: a fetcher that knows its
   *  cap did not bound the read leaves it out (git, docs), because "of up to 500" on a
   *  40-commit repo is printed every run and stops being read. */
  requested?: number;
  skips: CaptureSkip[];
  /** L3: true when the read reached the end of its window with nothing cut. Absent from a
   *  fetcher that cannot say (git, docs, and an SDK older than 0.10). */
  complete?: boolean;
  /** L3: the oldest `updated_at` the read saw, so an incomplete line can name the date it
   *  actually reached. Absent when no item carried one; never filled in from the clock. */
  oldestReached?: string;
  /** L3: 'team' when the token's whole visible scope was read, 'yours' for the caller's own items. */
  scope?: 'yours' | 'team';
  /** L3: items returned whole but waiting for their discussion (GitHub's items-first pass). */
  discussionPending?: number;
  /** L3: items fetched items-first that COULD have had discussion (the denominator for the above). */
  discussionTotal?: number;
}

/** L3: what every windowed fetch is given on top of its limit (see fetchWindow in since.ts). */
export interface WindowedOpts {
  /** ISO-8601 UTC lower bound. Absent means no bound: only the ceiling applies. */
  since?: string;
  /** Wall-clock budget for the whole read; running out is a `time_budget` skip. */
  timeBudgetMs?: number;
}

export interface CaptureFetchResult {
  items: PersonalImportItem[];
  report: CaptureFetchReport;
}

/**
 * The slice of a connector-core fetcher this wrapper needs, declared structurally so it
 * compiles against 0.5.0 (no `fetchWithReport`) and consumes 0.6.0's report the moment
 * the installed package has one. `kind` on each skip and the report's `complete`, `oldestReached` and
 * `scope` are carried through (L3); `platform` is dropped.
 */
export interface ReportingFetcher<O> {
  fetch(opts: O): Promise<PersonalImportItem[]>;
  fetchWithReport?(opts: O): Promise<{
    items: PersonalImportItem[];
    report: {
      scanned: number;
      requested?: number;
      skips: ReadonlyArray<{ kind?: string; count: number; detail: string }>;
      complete?: boolean;
      oldestReached?: string;
      scope?: 'yours' | 'team';
    };
  }>;
}

export async function withCaptureReport<O extends { limit?: number }>(
  opts: O,
  fetcher: ReportingFetcher<O>,
): Promise<CaptureFetchResult> {
  if (typeof fetcher.fetchWithReport === 'function') {
    // One read, never two: the SDK's `fetch` is defined as `(await fetchWithReport()).items`.
    const { items, report } = await fetcher.fetchWithReport(opts);
    const pending = items.filter((i) => (i as { detail_pending?: boolean }).detail_pending === true).length;
    return {
      items,
      report: {
        scanned: report.scanned,
        ...(report.requested !== undefined ? { requested: report.requested } : {}),
        skips: report.skips.map((s) => ({ ...(s.kind !== undefined ? { kind: s.kind } : {}), count: s.count, detail: s.detail })),
        ...(report.complete !== undefined ? { complete: report.complete } : {}),
        ...(report.oldestReached !== undefined ? { oldestReached: report.oldestReached } : {}),
        ...(report.scope !== undefined ? { scope: report.scope } : {}),
        ...(pending > 0 ? { discussionPending: pending } : {}),
      },
    };
  }
  const items = await fetcher.fetch(opts);
  return {
    items,
    report: {
      scanned: items.length,
      // Echoed whenever one was given: with no SDK report this wrapper cannot tell a cap
      // that bound the read from a source that simply had less, so it says the honest,
      // derived thing and leaves the reason to the fetcher.
      ...(opts.limit !== undefined ? { requested: opts.limit } : {}),
      skips: [],
    },
  };
}
