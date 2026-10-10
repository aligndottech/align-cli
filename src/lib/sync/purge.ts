/**
 * L5: `align local forget <source> --purge`. Forgetting a source drops its token and its sync rows
 * and keeps what it imported; `--purge` also deletes the imported items, but only ones nobody has
 * put their name to or ever handled.
 *
 * What may be purged: a row of a CONNECTOR source (never git, docs, sessions, cli or anything
 * else) that carries a `source_key`, which only a connector import ever sets. A row captured by
 * hand (`align capture <PR url>`, a plain-text capture) has none, so it cannot be purged even when
 * its platform says `github`. Note that `decider_kind` cannot separate imports from captures:
 * every connector import is derived `human` (decider-kind.ts), so it is not used here.
 *
 * Kept whatever the platform says: a ratified row, a confirmed row, a row with ANY audit act on it
 * (a `capture_seen` note is one: somebody captured it by hand after the import; only the notes the
 * system writes about its own text revisions and classification attempts are not acts), a row a
 * local judgement names as target or counterpart, and a row a promotion records (`promotions.local_id`).
 *
 * Every purged row is copied to `decisions_purged_backup` (with its vector and refs) in the same
 * transaction, so a purge can be undone by copying them back. Its links and sync-item state go with it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { copyRowsToBackup } from '../backup-copy.js';
import { createLocalDb } from '../local-db.js';
import { deleteDecisionWithDependents } from '../local-db-migrate.js';
import { BACKFILL_SOURCES } from '../mcp-backfill.js';
import { transact } from './sync-state.js';

/** Audit rows the system writes about itself. They are not acts. `capture_seen` is NOT here: it is a person's act. */
export const SYSTEM_AUDIT_ACTIONS = ['text_revision_pending', 'sync_classified'] as const;

/** The only names `--purge` accepts: sources a connector import fills. */
export const PURGEABLE_SOURCES: readonly string[] = [...BACKFILL_SOURCES, 'zoom'];
export const isPurgeable = (name: string): boolean => PURGEABLE_SOURCES.includes(name);

export interface PurgeResult { deleted: number; kept: number }

const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/** A WHERE fragment over `decisions d` selecting the rows a purge of one platform may delete. Binds the platform once. */
function disposableWhere(db: DatabaseSync): string {
  const marks = SYSTEM_AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ');
  const parts = [
    'd.platform = ?',
    'd.source_key IS NOT NULL',
    `d.platform NOT IN ('cli', 'agent-session')`,
    'd.ratified_at IS NULL',
    'd.confirmed_at IS NULL',
    `NOT EXISTS (SELECT 1 FROM decision_audit a WHERE a.decision_id = d.id AND a.action NOT IN (${marks}))`,
  ];
  if (hasTable(db, 'local_judgements')) {
    parts.push('NOT EXISTS (SELECT 1 FROM local_judgements j WHERE j.decision_id = d.id OR j.counterpart_id = d.id)');
  }
  if (hasTable(db, 'promotions')) {
    parts.push('NOT EXISTS (SELECT 1 FROM promotions p WHERE p.local_id = d.id)');
  }
  return parts.join(' AND ');
}

export function previewIn(db: DatabaseSync, platform: string): PurgeResult & { total: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE platform = ?').get(platform) as { n: number }).n;
  const deletable = isPurgeable(platform) ? (db.prepare(`SELECT COUNT(*) AS n FROM decisions d WHERE ${disposableWhere(db)}`).get(platform) as { n: number }).n : 0;
  return { deleted: deletable, kept: total - deletable, total };
}

/** Copy, then delete, inside the caller's transaction. */
export function purgeIn(db: DatabaseSync, platform: string): PurgeResult {
  if (!isPurgeable(platform)) throw new Error(`"${platform.slice(0, 24)}" is not a connector source, so nothing was purged.`);
  const { total } = previewIn(db, platform);
  const ids = (db.prepare(`SELECT d.id AS id FROM decisions d WHERE ${disposableWhere(db)}`).all(platform) as Array<{ id: string }>).map((r) => r.id);
  for (const id of ids) {
    copyRowsToBackup(db, 'decisions', 'decisions_purged_backup', 'id', id);
    copyRowsToBackup(db, 'decision_embeddings', 'decision_embeddings_purged_backup', 'decision_id', id);
    copyRowsToBackup(db, 'decision_refs', 'decision_refs_purged_backup', 'decision_id', id);
    deleteDecisionWithDependents(db, id);
    db.prepare('DELETE FROM sync_item_state WHERE decision_id = ?').run(id);
  }
  return { deleted: ids.length, kept: total - ids.length };
}

/** How many rows of this platform a purge would delete and keep. Reads only; refuses a name that is not a connector. */
export function purgePreview(dbPath: string, platform: string): PurgeResult {
  createLocalDb(dbPath).close(); // migrates an older file, refuses a newer one
  const r = transact(dbPath, (db) => previewIn(db, platform));
  return { deleted: r.deleted, kept: r.kept };
}

export function purgePlatform(dbPath: string, platform: string): PurgeResult {
  createLocalDb(dbPath).close();
  return transact(dbPath, (db) => purgeIn(db, platform));
}
