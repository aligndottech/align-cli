/**
 * ALI-215: the "what your graph did for you" value rollup. Aggregates the gateway's
 * per-tenant value signals into one normalized shape the status readout renders. Each
 * source is fetched independently and a failure nulls only its own field - an old gateway
 * missing /decisions/reuse-rate must not blank the whole readout.
 */

export interface ValueRollup {
  decisions: number;
  conflictsCaught: number;
  /**
   * Decisions linked by embedding similarity alone (ALI-503). Deliberately a separate
   * number from conflictsCaught: an embedding says two decisions are about the same thing,
   * never that they disagree. Populated offline only; the cloud rollup has richer signals.
   */
  similarDecisions: number;
  duplicates: number;
  supersessions: number;
  reuseRate: number | null;
  healthGrade: string | null;
}

/**
 * Decisions in a local graph before the sharing prompt is earned (ALI-503).
 *
 * The prompt used to be gated on conflictsCaught, which offline was fabricated from cosine
 * similarity, so a manufactured detection was what asked the user for money. Nothing writes
 * a conflict, duplicate or supersession link offline, so that gate is now structurally
 * false and needs a claim we can defend: a graph this size is worth sharing. 5 matches the
 * threshold `align ask` already nudges at.
 */
export const LOCAL_SHARE_THRESHOLD = 5;

export interface ValueRollupClient {
  getStats(): Promise<{ snapshots?: number }>;
  getConflictImpact(): Promise<{ total?: number }>;
  getLinkCounts(): Promise<{ duplicates_count?: number; supersessions_count?: number }>;
  getReuseRate(): Promise<{ rate: number | null }>;
  getHealth(): Promise<{ compositeScore?: { grade?: string } }>;
}

async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function fetchValueRollup(client: ValueRollupClient): Promise<ValueRollup> {
  const [stats, impact, links, reuse, health] = await Promise.all([
    settle(client.getStats()),
    settle(client.getConflictImpact()),
    settle(client.getLinkCounts()),
    settle(client.getReuseRate()),
    settle(client.getHealth()),
  ]);

  return {
    decisions: stats?.snapshots ?? 0,
    conflictsCaught: impact?.total ?? 0,
    // Cloud mode does not surface a similarity count; the gateway adjudicates instead.
    similarDecisions: 0,
    duplicates: links?.duplicates_count ?? 0,
    supersessions: links?.supersessions_count ?? 0,
    reuseRate: reuse ? reuse.rate : null,
    healthGrade: health?.compositeScore?.grade ?? null,
  };
}

/**
 * Render the value rollup as a terminal readout. Pure string builder (no I/O) so it's
 * unit-testable. Names value units - conflicts caught / duplicates / superseded / reuse -
 * never "connections". The upgrade nudge is EARNED: only shown when the graph has produced
 * real value (a conflict, duplicate, or supersession), tying the nudge to the sharing
 * ceiling rather than a generic wall.
 */
export function renderValueReadout(r: ValueRollup, opts: { mode: 'cloud' | 'local' }): string {
  const reuse = r.reuseRate === null ? 'n/a' : `${Math.round(r.reuseRate * 100)}%`;
  // ALI-503: offline, nothing can write a conflict link, so "N conflicts caught" was either
  // fabricated from cosine similarity or a permanent zero that reads as a broken counter.
  // Report what the local graph genuinely knows instead.
  const lines = [`  ${r.decisions} decisions in your graph`];
  if (opts.mode === 'local') {
    // ALI-794: offline, nothing writes a similarity, duplicate or supersession link on a
    // first run, so all three are structurally zero and a row of them reads as a broken
    // dashboard to someone ninety seconds into the tool. HIDDEN AT ZERO, never deleted -
    // localValueRollup still counts the real relations (ALI-503's positive control), so a
    // genuine one appears the moment it exists. Deleting the line would make that
    // impossible and would look identical from here.
    if (r.similarDecisions > 0) lines.push(`  ${r.similarDecisions} similar decisions found`);
    if (r.duplicates > 0) lines.push(`  ${r.duplicates} duplicates found`);
    if (r.supersessions > 0) lines.push(`  ${r.supersessions} decisions superseded`);
  } else {
    // Cloud can write every one of these, so a zero there is a measurement rather than a
    // gap, and the no-vanity-collapse rule keeps the labels visible.
    lines.push(`  ${r.conflictsCaught} conflicts caught`);
    lines.push(`  ${r.duplicates} duplicates found`);
    lines.push(`  ${r.supersessions} decisions superseded`);
  }
  lines.push(`  reuse rate: ${reuse}`);
  if (r.healthGrade) {
    lines.push(`  health: ${r.healthGrade}`);
  }
  if (opts.mode === 'local') {
    lines.push('');
    lines.push('  Reuse rate and health need the cloud graph - run `align login` to see them.');
  }
  // similarDecisions is deliberately absent: buying the upsell with a cosine artefact is
  // the defect this ticket exists to remove, not a smaller version of it (ALI-503).
  const hasValue = (opts.mode === 'local' && r.decisions >= LOCAL_SHARE_THRESHOLD)
    || r.conflictsCaught > 0 || r.duplicates > 0 || r.supersessions > 0;
  if (hasValue) {
    lines.push('');
    lines.push('  Share this graph with your team: https://app.align.tech/pricing');
  }
  return lines.join('\n');
}

export interface LocalRollupDb {
  getStats(): { decisions: number };
  listLinks(filter?: { relation?: string }): unknown[];
}

/**
 * The offline honest subset: decisions + conflict/duplicate/supersession counts derivable
 * from the local decision_links table. Reuse rate and composite health need the gateway,
 * so they are null here - we do NOT fabricate them offline (ALI-215 decision).
 */
export function localValueRollup(db: LocalRollupDb): ValueRollup {
  const count = (relation: string) => db.listLinks({ relation }).length;
  return {
    decisions: db.getStats().decisions,
    // Kept counting the real relations even though nothing offline writes one, so the
    // counter stays provably capable of reporting a conflict. That is what makes a zero
    // here mean "none found" rather than "the counter is broken" (ALI-503 positive control).
    conflictsCaught: count('conflicts_with') + count('contradicts'),
    similarDecisions: count('relates'),
    duplicates: count('duplicates'),
    supersessions: count('supersedes'),
    reuseRate: null,
    healthGrade: null,
  };
}
