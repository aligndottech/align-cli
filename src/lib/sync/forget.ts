/**
 * L5: what `align local forget <source>` does to the graph, beside dropping the token.
 * Without `--purge`: the source's sync rows and item state go (its window and watermark mean nothing
 * without a token) and the imported items stay; the caller is told how many. With `--purge`: the
 * items nobody has vouched for go too (purge.ts says which are kept and why).
 *
 * ONE transaction: a failure leaves the graph as it was, and the caller drops the token only after
 * this returns, so a failed forget never leaves a token-less source with half its state.
 */
import fs from 'node:fs';
import { createLocalDb } from '../local-db.js';
import { isPurgeable, previewIn, purgeIn, type PurgeResult } from './purge.js';
import { transact } from './sync-state.js';

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
  if (o.purge && !isPurgeable(source)) throw new Error(`"${source.slice(0, 24)}" is not a connector source, so nothing was purged.`);
  // Opening through the one opener migrates an older file (the tables below exist) and refuses a newer one.
  createLocalDb(dbPath).close();
  return transact(dbPath, (db) => {
    const syncRowsRemoved = Number(db.prepare('DELETE FROM source_sync WHERE source_id = ?').run(source).changes);
    db.prepare('DELETE FROM sync_item_state WHERE platform = ?').run(source);
    if (o.purge) {
      const purged = purgeIn(db, source);
      return { syncRowsRemoved, purged, staying: purged.kept };
    }
    return { syncRowsRemoved, staying: previewIn(db, source).total };
  });
}
