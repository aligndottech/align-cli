/**
 * L5: what `align local forget <source>` does to the graph, beside dropping the token.
 * Without `--purge`: the source's sync rows go (its window and watermark mean nothing without a
 * token) and the imported items stay; the caller is told how many. With `--purge`: the items
 * nobody has vouched for go too (purge.ts says which are kept and why).
 */
import fs from 'node:fs';
import { purgePlatform, purgePreview, type PurgeResult } from './purge.js';
import { deleteSource } from './sync-state.js';

export interface ForgetResult {
  syncRowsRemoved: number;
  /** Set only with `purge`. */
  purged?: PurgeResult;
  /** Items of the platform still in the graph afterwards. */
  staying: number;
}

export function forgetSourceData(dbPath: string | undefined, source: string, o: { purge: boolean }): ForgetResult {
  // A graph that does not exist has nothing to forget, and opening it would create it.
  if (dbPath === undefined || !fs.existsSync(dbPath)) return { syncRowsRemoved: 0, staying: 0, ...(o.purge ? { purged: { deleted: 0, kept: 0 } } : {}) };
  const syncRowsRemoved = deleteSource(dbPath, source);
  if (o.purge) {
    const purged = purgePlatform(dbPath, source);
    return { syncRowsRemoved, purged, staying: purged.kept };
  }
  const p = purgePreview(dbPath, source);
  return { syncRowsRemoved, staying: p.deleted + p.kept };
}
