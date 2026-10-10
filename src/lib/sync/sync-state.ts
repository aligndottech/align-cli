/**
 * L5: reads and writes of `source_sync` (schema v7) and of the one small table the schema did
 * not give the sync: `sync_item_state`, the vendor's own last-updated time per stored item.
 *
 * Why that table exists: Slack lists channel history by ROOT time, so a reply to an old thread
 * never shows up in a date window. The SDK's `hotThreads` is the remedy, and choosing the hot
 * ones needs each stored thread's last activity, which `decisions` does not hold. The same
 * numbers give the true top of a cycle that a ceiling split across several runs (see
 * `finishRun`). It is created lazily with IF NOT EXISTS: it is a cache of vendor facts the next
 * full read would rebuild, so it needs no migration and losing it costs one wide read.
 *
 * Every function opens its own short-lived handle with the 30 s busy_timeout, the same pairing
 * with WAL that source-sync-state.ts relies on: the MCP server reads while a sync child writes.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { CaptureSkip } from '../fetchers/capture.js';
import { assertSchemaSupported } from '../local-db-migrate.js';

export type SyncStatus = 'ok' | 'partial' | 'needs_reauth' | 'error';

export interface SyncRow {
  source_id: string;
  scope_key: string;
  scope: 'yours' | 'team';
  window_since: string | null;
  high_water: string | null;
  pending_until: string | null;
  status: SyncStatus;
  last_started_at: string | null;
  last_success_at: string | null;
  /** Every run stamps this; last_success_at is stamped only by a complete one. */
  last_attempt_at: string | null;
  /** The newest updated_at seen across a pending cycle, in THIS scope's own row. */
  cycle_top: string | null;
  items_last_run: number | null;
  skips_last_run: string | null;
  changed_via: 'cli' | 'mcp' | null;
  changed_by_agent: string | null;
}

export interface ScopeKey { source: string; scopeKey: string; scope: 'yours' | 'team' }

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    // A newer CLI's file is not ours to read or write: the same refusal migrate() makes.
    assertSchemaSupported((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    return fn(db);
  } finally {
    db.close();
  }
}

/** A reader must never create the graph it was asked to look at: opening a missing path makes an empty file. */
function readDb<T>(dbPath: string, fallback: T, fn: (db: DatabaseSync) => T): T {
  if (!fs.existsSync(dbPath)) return fallback;
  return withDb(dbPath, (db) => {
    try {
      return fn(db);
    } catch (e) {
      if (/no such (table|column)/i.test((e as Error).message)) return fallback;
      throw e;
    }
  });
}

/** Rows of one source (every scope), or of all sources. A file that has no `source_sync` yet reads as empty. */
export function readRows(dbPath: string, source?: string): SyncRow[] {
  return readDb<SyncRow[]>(dbPath, [], (db) => (source === undefined
    ? db.prepare('SELECT * FROM source_sync ORDER BY source_id, scope_key').all()
    : db.prepare('SELECT * FROM source_sync WHERE source_id = ? ORDER BY scope_key').all(source)) as unknown as SyncRow[]);
}

/**
 * Open a run: create the row if the scope is new (with `defaultWindowSince` as its window - an
 * existing row with a NULL window means "all", so a new row must never be left NULL), stamp
 * `last_started_at`, and return the row as stored. An existing row keeps everything else.
 */
export function beginRun(dbPath: string, key: ScopeKey, defaultWindowSince: string | null, nowIso: string): SyncRow {
  return withDb(dbPath, (db) => db.prepare(
    `INSERT INTO source_sync (source_id, scope_key, scope, window_since, last_started_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_id, scope_key) DO UPDATE SET last_started_at = excluded.last_started_at
     RETURNING *`,
  ).get(key.source, key.scopeKey, key.scope, defaultWindowSince, nowIso) as unknown as SyncRow);
}

export interface RunResult {
  status: SyncStatus;
  high_water: string | null;
  pending_until: string | null;
  /** The cycle's newest stamp while a cycle is pending; null once it ends. */
  cycle_top?: string | null;
  /** Stamped as last_attempt_at on every run. */
  attemptAt: string;
  items: number;
  skips: readonly CaptureSkip[];
  /** Stamped as last_success_at, or left as it was when absent: only a COMPLETE run is a success. */
  successAt?: string;
}

export function saveRun(dbPath: string, key: ScopeKey, r: RunResult): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `UPDATE source_sync SET status = ?, high_water = ?, pending_until = ?, cycle_top = ?, items_last_run = ?, skips_last_run = ?,
         last_attempt_at = ?, last_success_at = COALESCE(?, last_success_at)
       WHERE source_id = ? AND scope_key = ?`,
    ).run(r.status, r.high_water, r.pending_until, r.cycle_top ?? null, r.items, JSON.stringify(r.skips), r.attemptAt, r.successAt ?? null, key.source, key.scopeKey);
  });
}

/** Move the watermark FORWARD only, from inside a run: called after a batch has committed. */
export function advanceHighWater(dbPath: string, key: ScopeKey, to: string, now: Date): void {
  withDb(dbPath, (db) => {
    const row = db.prepare('SELECT high_water FROM source_sync WHERE source_id = ? AND scope_key = ?').get(key.source, key.scopeKey) as { high_water: string | null } | undefined;
    const stored = row?.high_water ? Date.parse(row.high_water) : Number.NaN;
    const next = Date.parse(to);
    // A stamp more than a day ahead of now (a vendor bug, a wrong clock) would hide every later change.
    if (Number.isNaN(next) || next > now.getTime() + 86_400_000) return;
    if (!Number.isNaN(stored) && stored >= next) return;
    db.prepare('UPDATE source_sync SET high_water = ? WHERE source_id = ? AND scope_key = ?').run(to, key.source, key.scopeKey);
  });
}

/**
 * The provider refused this source's token. Every scope row of the source says so (a refused
 * token is refused for the whole source), and a source with no row yet gets one, so the next
 * foreground moment has something to report. The token itself is never touched here.
 */
export function markNeedsReauth(dbPath: string, key: ScopeKey, defaultWindowSince: string | null, nowIso: string): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO source_sync (source_id, scope_key, scope, window_since, status, last_started_at)
       VALUES (?, ?, ?, ?, 'needs_reauth', ?)
       ON CONFLICT(source_id, scope_key) DO UPDATE SET status = 'needs_reauth'`,
    ).run(key.source, key.scopeKey, key.scope, defaultWindowSince, nowIso);
    db.prepare(`UPDATE source_sync SET status = 'needs_reauth' WHERE source_id = ?`).run(key.source);
  });
}

/** A fresh token was saved: the source is no longer waiting on the user. */
export function clearNeedsReauth(dbPath: string, source: string): void {
  withDb(dbPath, (db) => {
    try {
      db.prepare(`UPDATE source_sync SET status = 'ok' WHERE source_id = ? AND status = 'needs_reauth'`).run(source);
    } catch (e) {
      if (!/no such table/i.test((e as Error).message)) throw e;
    }
  });
}

/** `align local forget <source>`: the source's sync rows go with its token. Returns how many. */
export function deleteSource(dbPath: string, source: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  return withDb(dbPath, (db) => {
    try {
      return Number(db.prepare('DELETE FROM source_sync WHERE source_id = ?').run(source).changes);
    } catch (e) {
      if (/no such table/i.test((e as Error).message)) return 0;
      throw e;
    }
  });
}

export function recordActivity(dbPath: string, scopeKey: string, entries: ReadonlyArray<{ decisionId: string; platform: string; updatedAt: string }>): void {
  if (entries.length === 0) return;
  withDb(dbPath, (db) => {
    const put = db.prepare(
      `INSERT INTO sync_item_state (decision_id, scope_key, platform, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(decision_id, scope_key) DO UPDATE SET updated_at = excluded.updated_at, platform = excluded.platform`,
    );
    db.exec('BEGIN');
    try {
      for (const e of entries) put.run(e.decisionId, scopeKey, e.platform, e.updatedAt);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}

/** Stored items of a platform with their last known activity (null when none was recorded). */
export function threadRows(dbPath: string, platform: string): Array<{ source_url: string; last_activity: string | null }> {
  const plain = readDb<Array<{ source_url: string; last_activity: string | null }>>(dbPath, [], (db) => (db.prepare(
    `SELECT d.source_url AS source_url, NULL AS last_activity FROM decisions d WHERE d.platform = ? AND d.source_url IS NOT NULL`,
  ).all(platform) as Array<{ source_url: string; last_activity: string | null }>));
  if (plain.length === 0) return plain;
  // The activity table may not exist yet (nothing has been synced): then no thread has a known activity.
  return readDb(dbPath, plain, (db) => db.prepare(
    `SELECT d.source_url AS source_url, s.updated_at AS last_activity FROM decisions d
     LEFT JOIN sync_item_state s ON s.decision_id = d.id AND s.scope_key = 'yours'
     WHERE d.platform = ? AND d.source_url IS NOT NULL`,
  ).all(platform) as Array<{ source_url: string; last_activity: string | null }>);
}

/** Rows of this platform still waiting for their discussion (GitHub items-first). */
export function pendingDetailCount(dbPath: string, platform: string): number {
  return readDb(dbPath, 0, (db) => (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE platform = ? AND detail_pending = 1').get(platform) as { n: number }).n);
}

/** Rows whose link pass has not finished and that a re-link can finish (see unfinishedRows). */
export function unfinishedCount(dbPath: string, currentModel: string): number {
  return readDb(dbPath, 0, (db) => (db.prepare(
    `SELECT COUNT(*) AS n FROM decisions d LEFT JOIN decision_embeddings e ON e.decision_id = d.id
     WHERE d.enriched_at IS NULL AND (e.model = ? OR d.source_url IS NOT NULL)`,
  ).get(currentModel) as { n: number }).n);
}

/**
 * Ids of rows whose link pass is unfinished, oldest first, that a re-link CAN finish: it holds a
 * current-model embedding, or it has a URL to re-ingest from (see relinkUnfinished). `keyed`
 * says whether the row carries a source_key, so a re-ingest keeps its identity.
 */
export function unfinishedRows(dbPath: string, currentModel: string, limit: number): Array<{ id: string; keyed: boolean; pending: boolean }> {
  return readDb<Array<{ id: string; keyed: boolean; pending: boolean }>>(dbPath, [], (db) => {
    const rows = db.prepare(
      `SELECT d.id AS id, d.source_key AS source_key, d.detail_pending AS pending FROM decisions d
       LEFT JOIN decision_embeddings e ON e.decision_id = d.id
       WHERE d.enriched_at IS NULL AND (e.model = ? OR d.source_url IS NOT NULL)
       ORDER BY d.created_at ASC, d.rowid ASC LIMIT ?`,
    ).all(currentModel, limit) as Array<{ id: string; source_key: string | null; pending: number }>;
    return rows.map((r) => ({ id: r.id, keyed: r.source_key !== null, pending: r.pending === 1 }));
  });
}

export interface PendingRow { id: string; title: string; summary: string; source_url: string; decided_at: string | null }

/** Rows of a platform still waiting for their discussion, newest first (undated last). The SDK drain sorts
 *  what it is given as well, so this order decides only which undated rows come first. */
export function pendingRows(dbPath: string, platform: string): PendingRow[] {
  return readDb<PendingRow[]>(dbPath, [], (db) => db.prepare(
    `SELECT id, title, summary, source_url, decided_at FROM decisions
     WHERE platform = ? AND detail_pending = 1 AND source_url IS NOT NULL
     ORDER BY decided_at IS NULL, decided_at DESC, rowid DESC`,
  ).all(platform) as unknown as PendingRow[]);
}

/** Clear the flag on exactly these rows: the ones whose discussion was just read and stored. */
export function clearDetailPending(dbPath: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  withDb(dbPath, (db) => {
    const clear = db.prepare('UPDATE decisions SET detail_pending = 0 WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const id of ids) clear.run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
}

/** The stored text of the one-item-per-URL row a fetched item belongs to, for merging a partial read into it. */
export function storedByKey(dbPath: string, sourceKey: string): { title: string; summary: string } | undefined {
  return withDb(dbPath, (db) => db.prepare('SELECT title, summary FROM decisions WHERE source_key = ?').get(sourceKey) as { title: string; summary: string } | undefined);
}

/** Run `fn` in one IMMEDIATE transaction on its own handle: all of it commits, or none of it does. */
export function transact<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  return withDb(dbPath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  });
}

/**
 * A run died before it could say why (a database error, the re-link queue). Record it on each
 * source's rows so the next foreground moment and `align_sync` status can tell the person, instead of
 * the background child vanishing without a trace. Watermarks are untouched; a source with no row gets one.
 */
export function recordRunError(dbPath: string, sources: readonly string[], message: string, nowIso: string, defaultWindowSince: string): void {
  if (sources.length === 0) return;
  const skips = JSON.stringify([{ kind: 'error', count: 1, detail: message.slice(0, 200) }]);
  transact(dbPath, (db) => {
    for (const source of sources) {
      const has = db.prepare('SELECT 1 AS hit FROM source_sync WHERE source_id = ? LIMIT 1').get(source) !== undefined;
      if (!has) {
        db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope, window_since) VALUES (?, 'yours', 'yours', ?)`).run(source, defaultWindowSince);
      }
      db.prepare(`UPDATE source_sync SET status = CASE WHEN status = 'needs_reauth' THEN status ELSE 'error' END, skips_last_run = ?, last_attempt_at = ? WHERE source_id = ?`).run(skips, nowIso, source);
    }
  });
}
