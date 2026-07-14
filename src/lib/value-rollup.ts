/**
 * ALI-215: the "what your graph did for you" value rollup. Aggregates the gateway's
 * per-tenant value signals into one normalized shape the status readout renders. Each
 * source is fetched independently and a failure nulls only its own field - an old gateway
 * missing /decisions/reuse-rate must not blank the whole readout.
 */

export interface ValueRollup {
  decisions: number;
  conflictsCaught: number;
  duplicates: number;
  supersessions: number;
  reuseRate: number | null;
  healthGrade: string | null;
}

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
  const lines = [
    `  ${r.decisions} decisions in your graph`,
    `  ${r.conflictsCaught} conflicts caught`,
    `  ${r.duplicates} duplicates found`,
    `  ${r.supersessions} decisions superseded`,
    `  reuse rate: ${reuse}`,
  ];
  if (r.healthGrade) {
    lines.push(`  health: ${r.healthGrade}`);
  }
  if (opts.mode === 'local') {
    lines.push('');
    lines.push('  Reuse rate and health need the cloud graph - run `align login` to see them.');
  }
  const hasValue = r.conflictsCaught > 0 || r.duplicates > 0 || r.supersessions > 0;
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
    conflictsCaught: count('conflicts_with') + count('contradicts'),
    duplicates: count('duplicates'),
    supersessions: count('supersedes'),
    reuseRate: null,
    healthGrade: null,
  };
}
