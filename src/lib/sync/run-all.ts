/**
 * L5: one `align sync` invocation across sources: each source under its own lock, then the
 * re-link queue once (it belongs to the graph, not to a source), then the launch summary.
 */
import { SYNC_TIME_BUDGET_MS } from '../import-defaults.js';
import { relinkAll, type RelinkResult } from './relink.js';
import { type SourceOutcome, type SyncEnv, syncSource } from './run-source.js';

export interface SyncRunResult {
  outcomes: SourceOutcome[];
  /** Absent when another process holds the re-link lock (it is doing that work). */
  relink?: RelinkResult & { timedOut: boolean };
}

export async function runSync(
  sources: readonly string[],
  env: SyncEnv,
  o: { trigger: 'cli' | 'background'; onOutcome?: (o: SourceOutcome) => void } = { trigger: 'cli' },
): Promise<SyncRunResult> {
  const outcomes: SourceOutcome[] = [];
  const started = env.now().getTime();
  for (const source of sources) {
    const out = await syncSource(source, env, { trigger: o.trigger });
    outcomes.push(out);
    o.onOutcome?.(out);
  }
  const lock = env.lock('sync-relink');
  if (!lock.ok) return { outcomes };
  try {
    const relink = await relinkAll(env.dbPath, env.client, { deadlineAt: started + SYNC_TIME_BUDGET_MS, now: () => env.now().getTime() });
    return { outcomes, relink };
  } finally {
    lock.release();
  }
}

