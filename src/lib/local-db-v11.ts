/**
 * Schema v11 (ALI-1527): re-key zoom rows after connector-core 0.10.1 changed the zoom source key.
 *
 * Until 0.10.1 the key dropped the whole query for zoom, so the gateway's Discover recording URL
 * `https://zoom.us/recording/detail?meeting_id=<uuid>` keyed every meeting to
 * `zoom|https://zoom.us/recording/detail`. The key now keeps `meeting_id`. A graph written by an
 * older build can still hold a row under the collapsed key (the v7 twin merge folded every
 * Discover recording it saw into one such row).
 *
 * What it does: for each zoom row that has a key, recompute the key from the row's own source_url
 * with the current function. Same key: untouched. A key that no longer exists (the URL names no
 * item): cleared, and the row keeps its (source_url, title) identity. A different key that another
 * row already holds: the two are twins, folded with the v7 fold (a ratified or confirmed row
 * survives, everything that named the loser is re-pointed, the loser is backed up). Otherwise the
 * key is rewritten in place, so the id, ratification, judgements and promotions are untouched.
 *
 * It does NOT bring back rows the v7 merge already folded away under the collapsed key: those are
 * in `decisions_merged_backup`, and which of them were distinct meetings is a decision for a person.
 *
 * Replay-safe: a row already on the current key is skipped, so a second pass finds nothing.
 */
import type { DatabaseSync } from 'node:sqlite';
import { foldTwins, type TwinRow } from './local-db-v7.js';
import { connectorItemKey } from './source-key.js';

const TWIN_COLUMNS = 'id, rowid, created_at, title, summary, ratified_by, ratified_at, confirmed_by, confirmed_at';

export function migrateV11(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT id, source_url, source_key FROM decisions WHERE platform = 'zoom' AND source_key IS NOT NULL AND source_url IS NOT NULL ORDER BY rowid`)
    .all() as Array<{ id: string; source_url: string; source_key: string }>;
  for (const row of rows) {
    const next = connectorItemKey('zoom', row.source_url);
    if (next === row.source_key) continue;
    if (next === undefined) {
      db.prepare('UPDATE decisions SET source_key = NULL WHERE id = ?').run(row.id);
      continue;
    }
    const holder = db.prepare('SELECT id FROM decisions WHERE source_key = ? AND id <> ?').get(next, row.id) as { id: string } | undefined;
    if (holder === undefined) {
      db.prepare('UPDATE decisions SET source_key = ? WHERE id = ?').run(next, row.id);
      continue;
    }
    const twins = db.prepare(`SELECT ${TWIN_COLUMNS} FROM decisions WHERE id IN (?, ?) ORDER BY rowid`).all(row.id, holder.id) as unknown as TwinRow[];
    // The row holding the right key is the preferred survivor when neither is attested.
    foldTwins(db, twins, next, 'migration', holder.id);
  }
}
