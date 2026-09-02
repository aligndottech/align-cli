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
import type { CaptureSkip, CaptureSource } from '../capture-report.js';
import type { PersonalImportItem } from '../personal-import.js';

export interface CaptureFetchReport {
  /** Source objects examined before any filter. `items.length` is a fraction OF this. */
  scanned: number;
  /** What the caller asked for, when it asked for anything. */
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
      // Absent rather than a default: an unrequested cap is not a cap of zero.
      ...(opts.limit !== undefined ? { requested: opts.limit } : {}),
      skips: [],
    },
  };
}

/** The report line's inputs, from one wrapper result. `fetched` is what came BACK, not
 *  what was scanned: the user is counting decisions in their graph, not API rows. */
export function toCaptureSource(label: string, unit: string, result: CaptureFetchResult): CaptureSource {
  return {
    label,
    unit,
    fetched: result.items.length,
    ...(result.report.requested !== undefined ? { requested: result.report.requested } : {}),
    skips: result.report.skips,
  };
}
