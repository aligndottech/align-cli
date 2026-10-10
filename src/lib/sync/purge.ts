/**
 * L5: `align local forget <source> --purge`. Forgetting a source drops its token and its sync rows
 * and keeps what it imported; `--purge` also deletes the imported rows, but never one a person
 * has put their name to.
 *
 * Kept, whatever the platform says: a ratified row, a confirmed row (a human accepted it), a row
 * with an audit act on it (anything beyond the notes the system writes about itself), a row a local
 * judgement names (as the target or the counterpart), and a row a promotion records. Those are
 * the records someone may still want to share or stand behind, and nothing here can tell a
 * wanted import from an unwanted one except by the human act that marks it.
 *
 * One transaction, so a failure leaves the graph as it was. The dependents of a row (links, refs,
 * embeddings, notes) go with it through the one existing deleter.
 */
import { DatabaseSync } from 'node:sqlite';
import { deleteDecisionWithDependents } from '../local-db-migrate.js';

/** Audit rows the system writes about itself. They are not acts: a purge may delete a row that only has these. */
export const SYSTEM_AUDIT_ACTIONS = ['capture_seen', 'text_revision_pending', 'sync_classified'] as const;

export interface PurgeResult { deleted: number; kept: number }

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    return fn(db);
  } finally {
    db.close();
  }
}

const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/** SQL (a WHERE fragment over `decisions d`) selecting the rows nobody has vouched for. */
function disposableWhere(db: DatabaseSync): string {
  const marks = SYSTEM_AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ');
  const parts = [
    'd.platform = ?',
    'd.ratified_at IS NULL',
    'd.confirmed_at IS NULL',
    `NOT EXISTS (SELECT 1 FROM decision_audit a WHERE a.decision_id = d.id AND a.action NOT IN (${marks}))`,
  ];
  if (hasTable(db, 'local_judgements')) {
    parts.push('NOT EXISTS (SELECT 1 FROM local_judgements j WHERE j.decision_id = d.id OR j.counterpart_id = d.id)');
  }
  if (hasTable(db, 'promotions')) {
    parts.push('NOT EXISTS (SELECT 1 FROM promotions p WHERE p.decision_id = d.id)');
  }
  return parts.join(' AND ');
}

/** How many rows of this platform a purge would delete, and how many it would keep. */
export function purgePreview(dbPath: string, platform: string): PurgeResult {
  return withDb(dbPath, (db) => {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE platform = ?').get(platform) as { n: number }).n;
    const deletable = (db.prepare(`SELECT COUNT(*) AS n FROM decisions d WHERE ${disposableWhere(db)}`).get(platform) as { n: number }).n;
    return { deleted: deletable, kept: total - deletable };
  });
}

export function purgePlatform(dbPath: string, platform: string): PurgeResult {
  return withDb(dbPath, (db) => {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE platform = ?').get(platform) as { n: number }).n;
    const ids = (db.prepare(`SELECT d.id AS id FROM decisions d WHERE ${disposableWhere(db)}`).all(platform) as Array<{ id: string }>).map((r) => r.id);
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        deleteDecisionWithDependents(db, id);
        if (hasTable(db, 'sync_item_state')) db.prepare('DELETE FROM sync_item_state WHERE decision_id = ?').run(id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { deleted: ids.length, kept: total - ids.length };
  });
}
