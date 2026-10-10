/**
 * L5: one `align sync` invocation across sources: each source under its own lock, then the
 * re-link queue once (it belongs to the graph, not to a source), then the launch summary.
 */
/** The re-link queue gets its OWN budget, counted from when it starts: a source that spent all of its own must not leave the queue none. */
export const RELINK_BUDGET_MS = 60_000;
import { relinkAll, type RelinkResult } from './relink.js';
import { type SourceOutcome, type SyncEnv, syncSource } from './run-source.js';

export interface SyncRunResult {
  outcomes: SourceOutcome[];
  /** Absent when another process holds the re-link lock (it is doing that work). */
  relink?: RelinkResult & { timedOut: boolean };
  /** The re-link queue failed. The sources were already synced and recorded; this is reported, not thrown. */
  relinkError?: string;
}

export async function runSync(
  sources: readonly string[],
  env: SyncEnv,
  o: { trigger: 'cli' | 'background'; onOutcome?: (o: SourceOutcome) => void } = { trigger: 'cli' },
): Promise<SyncRunResult> {
  const outcomes: SourceOutcome[] = [];
  for (const source of sources) {
    const out = await syncSource(source, env, { trigger: o.trigger });
    outcomes.push(out);
    o.onOutcome?.(out);
  }
  const lock = env.lock('sync-relink');
  if (!lock.ok) return { outcomes };
  try {
    const relink = await relinkAll(env.dbPath, env.client, { deadlineAt: env.now().getTime() + RELINK_BUDGET_MS, now: () => env.now().getTime() });
    return { outcomes, relink };
  } catch (e) {
    return { outcomes, relinkError: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  } finally {
    lock.release();
  }
}

