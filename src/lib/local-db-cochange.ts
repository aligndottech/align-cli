/**
 * `co_change_rules` (additive, like `detector_version`): a rule of the form "a change touching
 * when_paths must also touch require_paths", owned by a decision. The paths are JSON arrays of
 * globs, the shape shared with the import lane and the hosted gateway (co-change.ts).
 *
 * `repo` is the same identity `decisions.repo` carries (repo-identity.ts), so a rule added in one checkout
 * does not fire in another. NULL (added outside a repo, or before the column) applies everywhere.
 *
 * A NEW TABLE, not a column on `decisions`: no existing writer names it, so none can write it
 * wrongly, and it does NOT bump user_version. An older CLI opens the graph and never reads the
 * table; its decision delete leaves an orphan rule, which the reader ignores by joining
 * `decisions`. `CREATE TABLE IF NOT EXISTS` is safe under a concurrent opener.
 */
import type { DatabaseSync } from 'node:sqlite';

export function hasCoChangeTable(db: DatabaseSync): boolean {
  const exists = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'co_change_rules'`).get() !== undefined;
  if (!exists) return false;
  return (db.prepare('PRAGMA table_info(co_change_rules)').all() as Array<{ name: string }>).some((c) => c.name === 'repo');
}

export function migrateCoChange(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS co_change_rules (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    repo TEXT,
    when_paths TEXT NOT NULL,
    require_paths TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'same_pr' CHECK (scope IN ('same_pr')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (decision_id, when_paths, require_paths)
  )`);
  // A table from before the repo column: add it. NULL reads as "applies in every repo", which is what those rules did.
  if (!(db.prepare('PRAGMA table_info(co_change_rules)').all() as Array<{ name: string }>).some((c) => c.name === 'repo')) {
    db.exec('ALTER TABLE co_change_rules ADD COLUMN repo TEXT');
  }
}
