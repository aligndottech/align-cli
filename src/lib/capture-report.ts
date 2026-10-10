/**
 * ALI-827: what an import fetched, and what it could not reach.
 *
 * A thin connector looks like a thin tool. `align setup --local` produced 39 Slack
 * decisions on 2026-09-02 and nothing said why; the number this prints is the number the
 * user was about to ask about, and printing it costs nothing - no model call, no extra
 * request, only the counts the fetch already had in its hands.
 *
 * Pure: a sort and a string builder over plain numbers and strings, no I/O and no chalk,
 * so it is unit-testable without a graph or a terminal (the found-summary.ts shape).
 *
 * It never states a REASON it did not measure. "30 of up to 50 requested" is derived and
 * true; "Zoom caps a page at 30" is a fact owned by the fetcher, and duplicating it here
 * would be a second writer of it (code-style.md). A skip line arrives from whoever
 * measured it and is printed verbatim.
 */
import { INCOMPLETE_SKIP_KINDS } from '@aligndottech/connector-core';
import type { CaptureFetchResult, CaptureSkip } from './fetchers/capture.js';

export interface CaptureSource {
  label: string;
  /** What one item IS here: 'threads', 'commits', 'pages'. A count with no noun is a
   *  number nobody can check. */
  unit: string;
  fetched: number;
  /** Source objects examined before any filter (CaptureFetchReport.scanned), when the
   *  caller has it. Optional so an older or hand-built CaptureSource still renders
   *  exactly as before (ALI-786): the clarifier below is additive, never required. */
  scanned?: number;
  /** What the caller asked for, when it asked for anything. */
  requested?: number;
  skips: CaptureSkip[];
  /** L3: the window this read covered, as the report prints it ("the last 6 months", from
   *  windowLabel). Present only for a windowed read; its presence is what switches the line
   *  to the "imported N ... from W" form, so a source without one prints exactly as before. */
  window?: string;
  /** L3: the SDK's `complete`. Anything but `false` reads as a complete windowed read. */
  complete?: boolean;
  /** L3: the oldest `updated_at` the read reached, named on an incomplete line. */
  oldestReached?: string;
  /** L3: GitHub items waiting for their discussion. */
  discussionPending?: number;
}

/**
 * L3: the line for a windowed read. Complete: what was imported and over which window.
 * Incomplete: the date actually reached and the skip that stopped it (Decision 5), so a thin
 * result is never mistaken for a quiet six months. The reason is the fetcher's own words
 * (verbatim, never a raw URL: the SDK redacts them and this adds nothing back).
 */
function windowedLine(s: CaptureSource, window: string): string {
  const head = `${s.label}: imported ${s.fetched} ${s.unit}`;
  const tail = s.discussionPending !== undefined && s.discussionPending > 0
    ? '; discussion is being added in the background'
    : '';
  if (s.complete !== false) return `${head} from ${window}${tail}`;
  const cut = s.skips.find((k) => k.kind !== undefined && (INCOMPLETE_SKIP_KINDS as ReadonlySet<string>).has(k.kind));
  const refused = s.fetched === 0 ? s.skips.find((k) => k.kind === 'shape') : undefined;
  const atCeiling = s.requested !== undefined && Math.max(s.fetched, s.scanned ?? 0) >= s.requested;
  const reason = (cut ?? refused)?.detail
    ?? (atCeiling ? `stopped at the ceiling of ${s.requested}` : 'the read did not reach the end of the window');
  const reached = s.oldestReached !== undefined ? `back to ${s.oldestReached.slice(0, 10)}` : 'read stopped early';
  return `${head}, ${reached} (not ${window}): ${reason}${tail}`;
}

export function renderCaptureReport(sources: CaptureSource[]): string {
  // Never a bare header over nothing.
  if (sources.length === 0) return '';

  // setup.ts fetches connectors concurrently, so the order sources ARRIVE is a race. Sort
  // by count, then by label - compared by code unit, not localeCompare, so the tie-break
  // is the same on every machine (latent-vs-deterministic.md).
  const ordered = [...sources].sort(
    (a, b) => b.fetched - a.fetched || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );

  const lines = ['  Capture report'];
  for (const s of ordered) {
    // Said only when fewer came back than were asked for: a full result is not a
    // shortfall, and a clause printed every time stops being read.
    const shortfall = s.requested !== undefined && s.fetched < s.requested
      ? ` of up to ${s.requested} requested`
      : '';
    // ALI-786: a zero-item source with no skip line is otherwise silent about whether
    // anything was even looked at - "Found 0 items" reads the same for an empty account
    // as for a token that could not see anything. Say what was measured (never a REASON
    // the fetcher did not measure - code-style.md, "never a second writer of it"): zero
    // scanned is a different claim from N scanned and none kept, so they get different
    // words. Skip lines already explain a zero when the fetcher has a reason; this only
    // fires when nothing else on the line already says why.
    // Copilot review, PR #272: state the measured NUMBER, not just the word "nothing" -
    // words alone can read as an inferred diagnosis (an empty account) when the only fact
    // in hand is the count.
    let scannedNote = '';
    if (s.fetched === 0 && s.skips.length === 0 && s.scanned !== undefined) {
      scannedNote = s.scanned === 0
        ? ' (0 scanned)'
        : ` (0 kept of ${s.scanned} scanned)`;
    }
    lines.push(`    ${s.window !== undefined ? windowedLine(s, s.window) : `${s.label}: ${s.fetched} ${s.unit}${shortfall}${scannedNote}`}`);
    for (const skip of s.skips) lines.push(`      ${skip.count} ${skip.detail}`);
  }
  return lines.join('\n');
}

/** The report line's inputs, from one wrapper result. `fetched` is what came BACK, not
 *  what was scanned: the user is counting decisions in their graph, not API rows. */
export function toCaptureSource(
  source: { label: string; unit: string },
  result: CaptureFetchResult,
  window?: string,
): CaptureSource {
  return {
    label: source.label,
    unit: source.unit,
    fetched: result.items.length,
    scanned: result.report.scanned,
    ...(result.report.requested !== undefined ? { requested: result.report.requested } : {}),
    skips: result.report.skips,
    ...(window !== undefined ? { window } : {}),
    ...(result.report.complete !== undefined ? { complete: result.report.complete } : {}),
    ...(result.report.oldestReached !== undefined ? { oldestReached: result.report.oldestReached } : {}),
    ...(result.report.discussionPending !== undefined ? { discussionPending: result.report.discussionPending } : {}),
  };
}

/**
 * Accumulates sources across the concurrent imports one `align setup` runs, so the report
 * prints once at the end instead of interleaved between spinners. Explicitly passed,
 * never a module-level singleton: a hidden global is untestable and would leak between
 * two commands in one process.
 */
export function createCaptureCollector(): { add(source: CaptureSource): void; render(): string } {
  const sources: CaptureSource[] = [];
  return {
    add(source: CaptureSource): void {
      sources.push(source);
    },
    render(): string {
      return renderCaptureReport(sources);
    },
  };
}
