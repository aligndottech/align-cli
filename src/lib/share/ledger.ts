/**
 * L9: reads and writes of `promotions` (schema v10), the record of what this machine shared where.
 *
 * Same pattern as curation/judgements-db.ts: every function opens its own short-lived handle so the
 * MCP server, a sync child and the share command can all be live, and a reader never creates a
 * missing graph file. A pre-v10 file reads as "nothing shared".
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertSchemaSupported } from '../local-db-migrate.js';

export interface Promotion {
  localId: string;
  env: string;
  tenantId: string;
  remoteId: string;
  contentHash: string;
  /** The share attached to a decision the team already held. Retracting it must NOT archive that decision. */
  matched: boolean;
  sharedAt: string;
  retractedAt: string | null;
}

/** The write side of a ledger row: the clock columns are the database's. */
export interface PromotionWrite {
  localId: string;
  env: string;
  tenantId: string;
  remoteId: string;
  contentHash: string;
  matched: boolean;
}

interface Row { local_id: string; env: string; tenant_id: string; remote_id: string; content_hash: string; matched: number; shared_at: string; retracted_at: string | null }

const fromRow = (r: Row): Promotion => ({
  localId: r.local_id, env: r.env, tenantId: r.tenant_id, remoteId: r.remote_id, contentHash: r.content_hash,
  matched: r.matched === 1, sharedAt: r.shared_at, retractedAt: r.retracted_at,
});

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    assertSchemaSupported((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    return fn(db);
  } finally {
    db.close();
  }
}

function readDb<T>(dbPath: string, fallback: T, fn: (db: DatabaseSync) => T): T {
  if (dbPath === '' || !fs.existsSync(dbPath)) return fallback;
  return withDb(dbPath, (db) => {
    try {
      return fn(db);
    } catch (e) {
      if (/no such table/i.test((e as Error).message)) return fallback;
      throw e;
    }
  });
}

export function getPromotion(dbPath: string, localId: string, env: string, tenantId: string): Promotion | null {
  return readDb<Promotion | null>(dbPath, null, (db) => {
    const r = db.prepare('SELECT * FROM promotions WHERE local_id = ? AND env = ? AND tenant_id = ?').get(localId, env, tenantId) as Row | undefined;
    return r ? fromRow(r) : null;
  });
}

/** A row `align push` left before the ledger existed: it names no workspace. */
export function getLegacyPromotion(dbPath: string, localId: string, env: string): Promotion | null {
  return getPromotion(dbPath, localId, env, 'legacy');
}

/** Insert, or replace the hash and remote id of an existing row; a re-share clears an earlier retraction. */
export function recordPromotion(dbPath: string, p: PromotionWrite): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash, matched) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (local_id, env, tenant_id) DO UPDATE SET
         remote_id = excluded.remote_id, content_hash = excluded.content_hash, matched = excluded.matched,
         shared_at = datetime('now'), retracted_at = NULL`,
    ).run(p.localId, p.env, p.tenantId, p.remoteId, p.contentHash, p.matched ? 1 : 0);
  });
}

export function markRetracted(dbPath: string, localId: string, env: string, tenantId: string): void {
  withDb(dbPath, (db) => {
    db.prepare(`UPDATE promotions SET retracted_at = datetime('now') WHERE local_id = ? AND env = ? AND tenant_id = ?`).run(localId, env, tenantId);
  });
}

/** Every live (not retracted) share into one workspace, keyed by local id. */
export function listPromotions(dbPath: string, env: string, tenantId: string): Map<string, Promotion> {
  return readDb<Map<string, Promotion>>(dbPath, new Map(), (db) => new Map(
    (db.prepare('SELECT * FROM promotions WHERE env = ? AND tenant_id = ? AND retracted_at IS NULL').all(env, tenantId) as unknown as Row[])
      .map((r) => [r.local_id, fromRow(r)] as const),
  ));
}
