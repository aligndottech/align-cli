/**
 * `decision_links.detector_version` (shared detector P3): an ADDITIVE step, not a schema version.
 *
 * Every link that exists when this runs was written by the v0 classifier, the cosine pass, a
 * ref match or a person's mark, so all of them read 'v0'. A link the v1 detector writes is
 * stamped 'v1'. Nothing is re-typed here: relation and confidence are untouched, and the only
 * path that re-types an existing link is the explicit `align local relink`.
 *
 * Review F7: it does NOT bump user_version. An older CLI (0.50.0 refuses anything above 11) keeps
 * opening the graph, and its link INSERTs, which name no detector_version, get the DEFAULT 'v0',
 * which is true of what they write. It runs on every open, in a write lock, only when the column
 * is missing, and re-checks inside the lock so two openers cannot both ALTER.
 */
import type { DatabaseSync } from 'node:sqlite';

export function hasDetectorVersion(db: DatabaseSync): boolean {
  return (db.prepare('PRAGMA table_info(decision_links)').all() as Array<{ name: string }>).some((c) => c.name === 'detector_version');
}

export function migrateV12(db: DatabaseSync): void {
  if (!hasDetectorVersion(db)) db.exec(`ALTER TABLE decision_links ADD COLUMN detector_version TEXT NOT NULL DEFAULT 'v0'`);
}
