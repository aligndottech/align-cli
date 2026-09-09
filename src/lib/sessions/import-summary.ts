/**
 * ALI-835: the line a human reads at the end of `align import sessions`, and the counts the
 * funnel reports.
 *
 * The line is the product moment; the ping is the measurement. They are built from ONE object
 * here so the two can never disagree - a summary saying 41 beside a ping saying 40 would make
 * both unusable, and nothing downstream could tell which was wrong.
 *
 * The demo beat this exists for (Madhuri, 2026-08-25): run the import on the prospect's own
 * repo, read the line aloud, ask who in the room knew.
 */

export interface SessionImportCounts {
  /** Session files read, across every detected agent. */
  sessionsScanned: number;
  /** Decision-shaped moments found, before review. */
  candidatesFound: number;
  /** How many of those a human confirmed into the graph this run. */
  candidatesConfirmed: number;
  /**
   * How many of the confirmed claims already carry a human ratification.
   *
   * Structurally 0 at import: `align import sessions` writes claims, and ratifying is a
   * separate human act (`align ratify`). It is reported anyway, because "0 have been ratified"
   * is the sentence the demo turns on - the point is that nobody has stood behind any of them
   * yet. The funnel's own decisions_ratified stage is emitted from `align ratify`, where the
   * number actually moves, rather than from here where it could only ever be zero.
   */
  ratified: number;
}

/**
 * The summary line.
 *
 * Renders honestly at zero rather than crashing or printing a line about nothing: "Found 0
 * decisions in 3 sessions" is a different sentence from "Found 0 decisions across 0 sessions",
 * and both are different from an exception. Singular and plural are handled for every count,
 * because "1 sessions" in a demo is the kind of detail that costs more attention than it saves.
 */
export function renderImportSummary(counts: SessionImportCounts): string {
  const { sessionsScanned, candidatesFound, candidatesConfirmed, ratified } = counts;
  const sessions = `${sessionsScanned} session${sessionsScanned === 1 ? '' : 's'}`;

  if (candidatesFound === 0) {
    // The ticket's own wording for the empty case. A run that found nothing is a real result,
    // not a failure, and it must not read like one.
    return `Found 0 decisions in ${sessions}.`;
  }

  const decisions = `${candidatesFound} decision${candidatesFound === 1 ? '' : 's'}`;
  const parts = [`Found ${decisions} across ${sessions}.`];

  // Every candidate here came from an agent's own session, so "made by an agent" is the whole
  // found set by construction rather than a second measurement. Stated as its own sentence
  // because it is the one a prospect reacts to.
  parts.push(`${candidatesFound} ${candidatesFound === 1 ? 'was' : 'were'} made by an agent.`);
  parts.push(`${ratified} ${ratified === 1 ? 'has' : 'have'} been ratified.`);

  if (candidatesConfirmed !== candidatesFound) {
    // Only when it differs, so the common "reviewed them all" run keeps a short line.
    parts.push(`${candidatesConfirmed} confirmed this run.`);
  }

  return parts.join(' ');
}
