/**
 * `co_change_rules` (additive, like `detector_version`): a rule of the form "a change touching
 * when_paths must also touch require_paths", owned by a decision. The paths are JSON arrays of
 * globs, the shape shared with the import lane and the hosted gateway (co-change.ts).
 *
 * A NEW TABLE, not a column on `decisions`: no existing writer names it, so none can write it
 * wrongly, and it does NOT bump user_version. An older CLI opens the graph and never reads the
 * table; its decision delete leaves an orphan rule, which the reader ignores by joining
 * `decisions`. `CREATE TABLE IF NOT EXISTS` is safe under a concurrent opener.
 */
import type { DatabaseSync } from 'node:sqlite';

export function hasCoChangeTable(db: DatabaseSync): boolean {
  return db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'co_change_rules'`).get() !== undefined;
}

export function migrateCoChange(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS co_change_rules (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    when_paths TEXT NOT NULL,
    require_paths TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'same_pr' CHECK (scope IN ('same_pr')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (decision_id, when_paths, require_paths)
  )`);
}
