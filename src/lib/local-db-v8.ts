/**
 * Schema v8 (L5 review): the sync's own state moves into the migration system.
 *
 * - `source_sync.cycle_top`: the newest `updated_at` seen across a pending cycle (a read a ceiling
 *   split over several runs), kept in the scope's own row so another scope's items can never
 *   lift this scope's watermark.
 * - `source_sync.last_attempt_at`: every run stamps it; `last_success_at` is stamped only by a
 *   COMPLETE run, so a source that is always partial no longer reads as freshly synced.
 * - `sync_item_state`: the vendor's own last-updated time per stored item and scope (hot Slack
 *   threads). A cache of vendor facts, rebuilt by the next wide read. An earlier, unreleased shape
 *   of this table (no scope column, created outside the migrations) is replaced and its rows carried across.
 * - `*_purged_backup`: every row `align local forget --purge` deletes is copied here first, with its
 *   vector and refs, inside the same transaction. Links, audit rows and judgements of a purged
 *   row are not copied (a purge never touches a row that has an audit act or a judgement).
 *
 * An earlier, unreleased shape of `sync_item_state` (no scope column) keeps its rows, as scope 'yours'.
 *
 * Replay-safe: every ALTER is guarded by table_info, every CREATE is IF NOT EXISTS.
 */
import type { DatabaseSync } from 'node:sqlite';

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

export function migrateV8(db: DatabaseSync): void {
  const sync = columnsOf(db, 'source_sync');
  for (const [name, ddl] of [['cycle_top', 'cycle_top TEXT'], ['last_attempt_at', 'last_attempt_at TEXT']] as const) {
    if (!sync.has(name)) db.exec(`ALTER TABLE source_sync ADD COLUMN ${ddl}`);
  }
  // An earlier, unreleased shape (no scope column, created outside the migrations) is set aside and its rows
  // carried across as scope 'yours', the only scope that ever wrote them.
  const state = columnsOf(db, 'sync_item_state');
  const legacy = state.size > 0 && !state.has('scope_key');
  if (legacy) db.exec('ALTER TABLE sync_item_state RENAME TO sync_item_state_unscoped');
  db.exec(`CREATE TABLE IF NOT EXISTS sync_item_state (
    decision_id TEXT NOT NULL,
    scope_key   TEXT NOT NULL DEFAULT 'yours',
    platform    TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (decision_id, scope_key)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_item_state_platform ON sync_item_state(platform)');
  if (legacy) {
    db.exec(`INSERT OR IGNORE INTO sync_item_state (decision_id, scope_key, platform, updated_at)
             SELECT decision_id, 'yours', platform, updated_at FROM sync_item_state_unscoped`);
    db.exec('DROP TABLE sync_item_state_unscoped');
  }
  db.exec('CREATE TABLE IF NOT EXISTS decisions_purged_backup AS SELECT * FROM decisions WHERE 0');
  db.exec('CREATE TABLE IF NOT EXISTS decision_embeddings_purged_backup AS SELECT * FROM decision_embeddings WHERE 0');
  db.exec('CREATE TABLE IF NOT EXISTS decision_refs_purged_backup AS SELECT * FROM decision_refs WHERE 0');
}
