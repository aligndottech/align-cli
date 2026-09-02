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
}

export interface CaptureFetchResult {
  items: PersonalImportItem[];
  report: CaptureFetchReport;
}

/**
 * The slice of a connector-core fetcher this wrapper needs, declared structurally so it
 * compiles against 0.5.0 (no `fetchWithReport`) and consumes 0.6.0's report the moment
 * the installed package has one. `kind` and `platform` on the SDK report are accepted and
 * dropped: the CLI prints the detail and branches on nothing else.
 */
export interface ReportingFetcher<O> {
  fetch(opts: O): Promise<PersonalImportItem[]>;
  fetchWithReport?(opts: O): Promise<{
    items: PersonalImportItem[];
    report: { scanned: number; requested?: number; skips: ReadonlyArray<{ count: number; detail: string }> };
  }>;
}

export async function withCaptureReport<O extends { limit?: number }>(
  opts: O,
  fetcher: ReportingFetcher<O>,
): Promise<CaptureFetchResult> {
  if (typeof fetcher.fetchWithReport === 'function') {
    // One read, never two: the SDK's `fetch` is defined as `(await fetchWithReport()).items`.
    const { items, report } = await fetcher.fetchWithReport(opts);
    return {
      items,
      report: {
        scanned: report.scanned,
        ...(report.requested !== undefined ? { requested: report.requested } : {}),
        skips: report.skips.map((s) => ({ count: s.count, detail: s.detail })),
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
