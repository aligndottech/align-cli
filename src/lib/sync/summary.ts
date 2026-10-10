/**
 * L5, Decision 8: `sync-summary.json`, the one file the launch path reads. `source_sync` in SQLite
 * is the truth; this is a derived cache with ONE writer (the sync job and the few commands that
 * change what is connected), so launch can decide whether to start a background sync without
 * importing the database layer.
 *
 * Written atomically (a sibling file, renamed over), mode 0600, inside the private state
 * directory. Reading tolerates a missing, corrupt or foreign file by returning undefined: the
 * launch path then spawns nothing, which is the safe direction.
 */
import fs from 'node:fs';
import { alignStateDir } from '../backfill-state.js';
import { BACKFILL_SOURCES } from '../mcp-backfill.js';
import { readRows, type SyncStatus } from './sync-state.js';
import { readSummary, SUMMARY_FILE, summaryPath, type SummarySource, type SyncSummary } from './summary-read.js';

/** The read side lives in summary-read.ts (the launch path imports it; this file reaches SQLite). */
export { SUMMARY_FILE, type SummarySource, type SyncSummary, readSummary, summaryPath };

const SEVERITY: Record<SyncStatus, number> = { ok: 0, partial: 1, error: 2, needs_reauth: 3 };

export function buildSummary(dbPath: string, isConnected: (id: string) => boolean, now: Date): SyncSummary {
  const all = readRows(dbPath);
  const sources: SummarySource[] = [];
  for (const id of BACKFILL_SOURCES) {
    if (!isConnected(id)) continue;
    const rows = all.filter((r) => r.source_id === id);
    let status: SummarySource['status'] = 'never';
    for (const r of rows) if (status === 'never' || SEVERITY[r.status] > SEVERITY[status]) status = r.status;
    let last: string | undefined;
    for (const r of rows) {
      if (r.last_success_at === null || Number.isNaN(Date.parse(r.last_success_at))) continue;
      if (last === undefined || Date.parse(r.last_success_at) > Date.parse(last)) last = r.last_success_at;
    }
    let attempt: string | undefined;
    for (const r of rows) {
      if (r.last_attempt_at === null || Number.isNaN(Date.parse(r.last_attempt_at))) continue;
      if (attempt === undefined || Date.parse(r.last_attempt_at) > Date.parse(attempt)) attempt = r.last_attempt_at;
    }
    sources.push({ id, backgroundEligible: id !== 'teams', status, ...(last !== undefined ? { lastSuccessAt: last } : {}), ...(attempt !== undefined ? { lastAttemptAt: attempt } : {}) });
  }
  return { version: 1, generated_at: now.toISOString(), sources };
}

/** Returns false when it could not write (an unusable state directory); nothing else depends on it. */
export function writeSummary(summary: SyncSummary, dir: string | null = alignStateDir()): boolean {
  const file = summaryPath(dir);
  if (file === null) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(summary), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

/** Rebuild and write it. Called after a sync, and when a source is connected or forgotten. */
export function refreshSummary(dbPath: string, isConnected: (id: string) => boolean, now: Date = new Date(), dir?: string | null): boolean {
  try {
    return writeSummary(buildSummary(dbPath, isConnected, now), dir);
  } catch {
    return false;
  }
}
