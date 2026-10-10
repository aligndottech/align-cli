/**
 * Copy rows into a `*_backup` table by column NAME, never by position.
 *
 * The backup tables (`decisions_merged_backup`, `decisions_purged_backup`, ...) are created with
 * `CREATE TABLE ... AS SELECT * ... WHERE 0`, so they carry the columns their source had on the day
 * of the migration. A later migration that adds a column to `decisions` would make a positional
 * `INSERT INTO backup SELECT * FROM decisions` fail ("table has N columns but M values were
 * supplied") on every purge and on EVERY ingest that folds a twin. Naming the columns keeps both
 * working; the columns the backup lacks are then the only thing not backed up, and
 * backup-copy.test.ts fails the build when that set is not empty, so the migration that adds the
 * column must add it to the backup table too.
 */
import type { DatabaseSync } from 'node:sqlite';

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** The columns both tables have, in the backup table's order. */
export function sharedColumns(db: DatabaseSync, source: string, backup: string): string[] {
  const have = new Set(columns(db, source));
  return columns(db, backup).filter((c) => have.has(c));
}

export function copyRowsToBackup(db: DatabaseSync, source: string, backup: string, keyColumn: string, key: string): void {
  const cols = sharedColumns(db, source, backup).map((c) => `"${c}"`).join(', ');
  db.prepare(`INSERT INTO ${backup} (${cols}) SELECT ${cols} FROM ${source} WHERE ${keyColumn} = ?`).run(key);
}
