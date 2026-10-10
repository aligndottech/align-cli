/**
 * Schema v12 (shared detector, P3): `decision_links.detector_version`.
 *
 * Every link that exists when this runs was written by the v0 classifier, the cosine pass, a
 * ref match or a person's mark, so all of them read 'v0'. A link the v1 detector writes is
 * stamped 'v1'. Nothing is re-typed here: relation and confidence are untouched, and the only
 * path that re-types an existing link is the explicit `align local relink`.
 *
 * The ALTER is conditional so a replay (user_version put back) is a no-op, and runs inside the
 * caller's write lock, for the reason step 4 in local-db-migrate.ts gives.
 */
import type { DatabaseSync } from 'node:sqlite';

export function migrateV12(db: DatabaseSync): void {
  const has = (db.prepare('PRAGMA table_info(decision_links)').all() as Array<{ name: string }>)
    .some((c) => c.name === 'detector_version');
  if (!has) db.exec(`ALTER TABLE decision_links ADD COLUMN detector_version TEXT NOT NULL DEFAULT 'v0'`);
}
