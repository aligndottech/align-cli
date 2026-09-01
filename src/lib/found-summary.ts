/**
 * ALI-794: the "here's what I found" summary - the first thing a fresh user sees,
 * before any credential is asked for.
 *
 * It replaces the bare `Imported N decisions from Git` spinner line, which reports
 * that a mechanism ran and says nothing about what is now in the graph. This names
 * real decisions by title, so the payoff is checkable against the user's own repo
 * rather than a number they have to trust.
 *
 * Pure: a reducer over the local db and a string builder, no I/O and no chalk, so
 * the wow moment is unit-testable without a graph or a terminal (same shape as
 * value-rollup.ts's renderValueReadout).
 */
import { localCitationFor } from './commit-cite.js';

/** How many decisions the summary names. Five fits a terminal without scrolling. */
export const FOUND_SUMMARY_MAX = 5;

export interface FoundDecision {
  title: string;
  /** Present only when the source url yields one - never a placeholder. */
  cite?: string;
}

export interface FoundSummary {
  /** Decisions in the whole graph, from the db's own count. */
  total: number;
  /** Decisions carrying at least one link. Distinct DECISIONS, not link rows. */
  linked: number;
  recent: FoundDecision[];
}

/** The slice of the local db this needs. Narrow on purpose: it takes a db, not a client. */
export interface FoundSummaryDb {
  getStats(): { decisions: number };
  listDecisions(): Array<{ id: string; title: string; sourceUrl?: string | null }>;
  listLinks(filter?: { relation?: string }): Array<{ sourceId: string; targetId: string }>;
}

export function buildFoundSummary(db: FoundSummaryDb): FoundSummary {
  // The graph total comes from the db's COUNT, never from the length of the page
  // below - those differ by two orders of magnitude on a real repo, and reporting
  // the slice would understate the import that just ran.
  const total = db.getStats().decisions;

  // "12 linked" is a claim about decisions, so both ends of every link are collected
  // into a set. Counting link rows would double every reciprocal edge and treat two
  // links between one pair as two connected decisions.
  const touched = new Set<string>();
  for (const link of db.listLinks()) {
    touched.add(link.sourceId);
    touched.add(link.targetId);
  }

  // listDecisions() is already ordered created_at DESC, so the head of it is the
  // recent page. The cap is applied here rather than in the renderer so a caller
  // reading `recent.length` gets the number that will actually be printed.
  const recent = db.listDecisions().slice(0, FOUND_SUMMARY_MAX).map((row) => {
    const cite = localCitationFor(row.sourceUrl);
    return { title: row.title, ...(cite ? { cite } : {}) };
  });

  return { total, linked: touched.size, recent };
}

export function renderFoundSummary(s: FoundSummary): string {
  if (s.total === 0) {
    // A row of zeros reads as a broken tool, which is the ALI-503 lesson applied to
    // the first run. Say what is true and let the caller suggest a next source.
    return '  No decisions found in this history yet.';
  }

  // The connections count is omitted at zero rather than printed as "0 linked". A
  // git-only import links nothing, so on the most common first run that number would
  // be a permanent zero beside a real one - the same broken-counter read this ticket
  // removes from `align status`.
  const counts = s.linked > 0
    ? `  ${s.total} decisions found, ${s.linked} with connections`
    : `  ${s.total} decisions found`;

  const lines = [counts];
  if (s.recent.length > 0) {
    lines.push('');
    for (const d of s.recent) {
      // Two spaces rather than a bracket: a decision with no cite must not leave an
      // empty pair of parentheses behind, and this way there is nothing to leave.
      lines.push(`    ${d.title}${d.cite ? `  ${d.cite}` : ''}`);
    }
  }
  return lines.join('\n');
}
