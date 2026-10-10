/**
 * L5/L6, Decision 8: the READ side of `sync-summary.json`, split out of summary.ts so the launch
 * path can import it. summary.ts also builds the file from SQLite (sync-state.ts -> node:sqlite),
 * and the launch path imports no database layer (launch-path-imports.test.ts). This file imports
 * `node:fs`, `node:path` and the state-directory helper, and nothing else.
 *
 * Reading tolerates a missing, corrupt or foreign file by returning undefined: the launch hook
 * then spawns nothing, which is the safe direction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { alignStateDir } from '../backfill-state.js';
import type { SyncStatus } from './sync-state.js';

export const SUMMARY_FILE = 'sync-summary.json';

export interface SummarySource {
  id: string;
  /** Connected, and a kind of source a background run can read (not Teams, Decision 21). */
  backgroundEligible: boolean;
  status: SyncStatus | 'never';
  lastSuccessAt?: string;
  /** Any run, complete or not: the launch hook spaces its attempts by this, so a source that is always partial is not retried on every launch. */
  lastAttemptAt?: string;
}

export interface SyncSummary { version: 1; generated_at: string; sources: SummarySource[] }

export function summaryPath(dir: string | null = alignStateDir()): string | null {
  return dir === null ? null : path.join(dir, SUMMARY_FILE);
}

export function readSummary(dir: string | null = alignStateDir()): SyncSummary | undefined {
  const file = summaryPath(dir);
  if (file === null) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SyncSummary>;
    if (raw.version !== 1 || !Array.isArray(raw.sources) || typeof raw.generated_at !== 'string') return undefined;
    const sources = raw.sources.filter((s): s is SummarySource => typeof s?.id === 'string' && typeof s.backgroundEligible === 'boolean');
    return { version: 1, generated_at: raw.generated_at, sources };
  } catch {
    return undefined;
  }
}
