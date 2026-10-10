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
  /** The opaque idempotency key sent as `client_key` at the first share; reused for every later one. */
  clientKey: string;
  /** Hashes of judgements already stored in that workspace. */
  sent: string[];
  /** A matched share whose ratify/supersede still waits for the person to confirm the team's text. */
  confirmPending: boolean;
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
  clientKey: string;
  sent: string[];
  confirmPending: boolean;
}

export interface LedgerRow { local_id: string; env: string; tenant_id: string; remote_id: string; content_hash: string; matched: number; client_key: string; sent: string; confirm_pending: number; shared_at: string; retracted_at: string | null }

function parseSent(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

const fromRow = (r: LedgerRow): Promotion => ({
  localId: r.local_id, env: r.env, tenantId: r.tenant_id, remoteId: r.remote_id, contentHash: r.content_hash,
  matched: r.matched === 1, clientKey: r.client_key, sent: parseSent(r.sent), confirmPending: r.confirm_pending === 1, sharedAt: r.shared_at, retractedAt: r.retracted_at,
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
    const r = db.prepare('SELECT * FROM promotions WHERE local_id = ? AND env = ? AND tenant_id = ?').get(localId, env, tenantId) as LedgerRow | undefined;
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
      `INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash, matched, client_key, sent, confirm_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (local_id, env, tenant_id) DO UPDATE SET
         remote_id = excluded.remote_id, content_hash = excluded.content_hash, matched = excluded.matched,
         client_key = excluded.client_key, sent = excluded.sent, confirm_pending = excluded.confirm_pending,
         shared_at = datetime('now'), retracted_at = NULL`,
    ).run(p.localId, p.env, p.tenantId, p.remoteId, p.contentHash, p.matched ? 1 : 0, p.clientKey, JSON.stringify([...new Set(p.sent)]), p.confirmPending ? 1 : 0);
  });
}

const UPSERT = `INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash, matched, client_key, sent, confirm_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (local_id, env, tenant_id) DO UPDATE SET
         remote_id = excluded.remote_id, content_hash = excluded.content_hash, matched = excluded.matched,
         client_key = excluded.client_key, sent = excluded.sent, confirm_pending = excluded.confirm_pending,
         shared_at = datetime('now'), retracted_at = NULL`;

/** Several rows in ONE transaction: all of them land or none do. */
export function recordPromotions(dbPath: string, rows: readonly PromotionWrite[]): void {
  if (rows.length === 0) return;
  withDb(dbPath, (db) => {
    const up = db.prepare(UPSERT);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of rows) up.run(p.localId, p.env, p.tenantId, p.remoteId, p.contentHash, p.matched ? 1 : 0, p.clientKey, JSON.stringify([...new Set(p.sent)]), p.confirmPending ? 1 : 0);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
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
    (db.prepare('SELECT * FROM promotions WHERE env = ? AND tenant_id = ? AND retracted_at IS NULL').all(env, tenantId) as unknown as LedgerRow[])
      .map((r) => [r.local_id, fromRow(r)] as const),
  ));
}

/** Every ledger row, raw, so a reset can carry the record of what was shared across a wipe. [] when there is none. */
export function exportLedger(dbPath: string): LedgerRow[] {
  return readDb<LedgerRow[]>(dbPath, [], (db) => db.prepare('SELECT * FROM promotions').all() as unknown as LedgerRow[]);
}

/** Put exported rows back (replay-safe: the key is the table's primary key). */
export function restoreLedger(dbPath: string, rows: readonly LedgerRow[]): void {
  if (rows.length === 0) return;
  withDb(dbPath, (db) => {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO promotions (local_id, env, tenant_id, remote_id, content_hash, matched, client_key, sent, confirm_pending, shared_at, retracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) ins.run(r.local_id, r.env, r.tenant_id, r.remote_id, r.content_hash, r.matched, r.client_key, r.sent, r.confirm_pending, r.shared_at, r.retracted_at);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });
}
