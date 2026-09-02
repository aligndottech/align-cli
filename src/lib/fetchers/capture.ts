/**
 * ALI-827: one place that turns a fetcher's read into a capture report, so a
 * connector-core that cannot report yet (0.5.0, every fetcher) and one that can differ
 * in exactly one branch rather than in nine wrappers.
 *
 * With no report from the fetcher, the fallback says only what the CALLER can honestly
 * say: how many came back, and how many were asked for. It never guesses a reason -
 * "zoom returns at most 30" is a fact the fetcher owns, and stating it here would be a
 * second writer of it (code-style.md). When the SDK grows `fetchWithReport`, its report
 * replaces the fallback here and nowhere else.
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
  /** Source objects examined before any filter. `items.length` is a fraction OF this. */
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

export async function withCaptureReport(
  opts: { limit?: number },
  run: () => Promise<PersonalImportItem[]>,
): Promise<CaptureFetchResult> {
  const items = await run();
  return {
    items,
    report: {
      scanned: items.length,
      // Echoed whenever one was given: with no SDK report this wrapper cannot tell a cap
      // that bound the read from a source that simply had less, so it says the honest,
      // derived thing and leaves the reason to the fetcher (PR 3 of the plan).
      ...(opts.limit !== undefined ? { requested: opts.limit } : {}),
      skips: [],
    },
  };
}
