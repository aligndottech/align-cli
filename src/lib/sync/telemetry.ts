/**
 * L7: the sync's one telemetry event, `source_synced`. This file only decides WHICH outcomes
 * count and what the five reported values are; consent, CI, hook and DO_NOT_TRACK rules, the
 * closed lists and the wire shape all live in `recordFunnelStage` (usage-telemetry.ts), so there
 * is one enforcement point.
 *
 * The body is built from a fixed set of five fields - never by stripping a richer outcome, which
 * carries a message, a scope note, skip details and window dates a ping must never see.
 */
import type { SourceOutcome } from './run-source.js';
import type { SyncMeasurement } from '../usage-telemetry.js';

export type ReportedTrigger = SyncMeasurement['trigger'];

const REPORTED_STATES: ReadonlySet<string> = new Set(['ok', 'partial', 'needs_reauth', 'error']);

/** Undefined when the outcome is not a sync that ran (locked, not connected, a backfill in the way, Teams by hand) or has no scope to name. */
export function syncMeasurementOf(o: SourceOutcome, trigger: ReportedTrigger): SyncMeasurement | undefined {
  if (!REPORTED_STATES.has(o.state) || o.scope === undefined) return undefined;
  return {
    count: o.created + o.updated,
    source: o.source as SyncMeasurement['source'],
    outcome: o.state as SyncMeasurement['outcome'],
    scope: o.scope,
    trigger,
  };
}

/** Each source's ping waits at most this long, and `align sync` waits at most SYNC_TELEMETRY_TOTAL_MS for all of them together. */
export const SOURCE_PING_CAP_MS = 1_000;
export const SYNC_TELEMETRY_TOTAL_MS = 1_500;

/** One `source_synced` ping for one outcome, local graph only. Never throws and never prints. */
export async function recordSourceSynced(o: SourceOutcome, trigger: ReportedTrigger): Promise<void> {
  try {
    const m = syncMeasurementOf(o, trigger);
    if (m === undefined) return;
    const { createConfigStore } = await import('../config.js');
    const { recordFunnelStage } = await import('../usage-telemetry.js');
    await recordFunnelStage(createConfigStore().getEnvironment('local'), 'source_synced', 'sync', m, { capMs: SOURCE_PING_CAP_MS });
  } catch {
    // Telemetry never fails a sync.
  }
}
