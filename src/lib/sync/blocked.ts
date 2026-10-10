/**
 * L6: sources a background run found it cannot read until a person acts: `manual` (Confluence with no
 * spaces chosen, Teams) or `not_connected`. Such a run writes no timestamp, so the launcher would
 * start a child for it every interval for ever. The child leaves a small marker here instead; the
 * summary builder reads it and lists the source as not schedulable, and the next run of that source
 * that gets further clears it. File-system only (neither the launcher nor the summary reader opens it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { alignStateDir } from '../backfill-state.js';
import { isKnownSource } from './source-ids.js';
import { readRegularFile } from './safe-read.js';

export type BlockedState = 'manual' | 'not_connected';
const file = (dir: string, source: string): string => path.join(dir, `${source}.blocked.json`);

export function writeBlocked(source: string, state: BlockedState, reason: string, dir: string | null = alignStateDir()): void {
  if (dir === null || !isKnownSource(source)) return;
  try { fs.writeFileSync(file(dir, source), JSON.stringify({ state, reason: reason.slice(0, 300) }), { mode: 0o600 }); } catch { /* the next interval tries again */ }
}

export function clearBlocked(source: string, dir: string | null = alignStateDir()): void {
  if (dir === null || !isKnownSource(source)) return;
  try { fs.rmSync(file(dir, source), { force: true }); } catch { /* as above */ }
}

export function readBlocked(source: string, dir: string | null = alignStateDir()): { state: BlockedState; reason: string } | undefined {
  if (dir === null || !isKnownSource(source)) return undefined;
  const raw = readRegularFile(file(dir, source), 4096);
  if (raw === undefined) return undefined;
  try {
    const b = JSON.parse(raw) as { state?: unknown; reason?: unknown };
    return (b.state === 'manual' || b.state === 'not_connected') ? { state: b.state, reason: typeof b.reason === 'string' ? b.reason : '' } : undefined;
  } catch { return undefined; }
}
