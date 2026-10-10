/**
 * Schema v9 (L5 second review): a hole that comes back run after run has to be NAMED and counted, or the
 * source re-reads it forever (or, worse, hides it). `source_sync.hole_sig` is a signature of what the last
 * incomplete run could not read and `hole_streak` is how many consecutive runs had that same hole; after
 * five, the sync says plainly that it is a persistent hole and stops letting it hold the watermark back.
 * Guarded ALTERs: replay-safe.
 */
import type { DatabaseSync } from 'node:sqlite';

export function migrateV9(db: DatabaseSync): void {
  const have = new Set((db.prepare('PRAGMA table_info(source_sync)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!have.has('hole_sig')) db.exec('ALTER TABLE source_sync ADD COLUMN hole_sig TEXT');
  if (!have.has('hole_streak')) db.exec('ALTER TABLE source_sync ADD COLUMN hole_streak INTEGER NOT NULL DEFAULT 0');
}
