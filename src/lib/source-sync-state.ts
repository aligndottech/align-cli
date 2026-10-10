/**
 * L3: the slice of `source_sync` (schema v7) that `align_backfill` needs before L5's sync
 * exists: is this source waiting on the user to re-authenticate, and what window did the user
 * ask for. L5 owns the watermark columns (high_water, pending_until, last_*, items_last_run);
 * nothing here writes them, and an upsert here never clears one.
 *
 * Opens its own short-lived handle on purpose. The MCP server holds the graph open through the
 * local gateway client; this is a one-row read or write, and WAL plus the 30 s busy_timeout
 * (set below, as local-db.ts sets it) is the case that pairing exists for.
 */
import { DatabaseSync } from 'node:sqlite';

/** The scope this phase writes under: the caller's own items. L4 adds repo/project/space keys
 *  ('repo:o/r', 'jira:ALI', ...) when scope pickers land, and L5's nextWindow reads whichever
 *  row is in force. */
export const WINDOW_SCOPE_KEY = 'yours';

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    return fn(db);
  } finally {
    db.close();
  }
}

/** `needsReauth` is true when ANY scope row of the source says so: a token the vendor refused
 *  is refused for the whole source. Absence of a row is no problem, not a pass. */
export function readSyncStatus(dbPath: string, sourceId: string): { needsReauth: boolean } {
  return withDb(dbPath, (db) => {
    const row = db.prepare(`SELECT 1 AS hit FROM source_sync WHERE source_id = ? AND status = 'needs_reauth' LIMIT 1`).get(sourceId);
    return { needsReauth: row !== undefined };
  });
}

/** Record the window the user asked for. `null` is `all`: no lower bound, only the ceiling. */
export function recordWindowSince(dbPath: string, sourceId: string, windowSince: string | null, changedByAgent: string): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO source_sync (source_id, scope_key, scope, window_since, changed_via, changed_by_agent)
       VALUES (?, ?, 'yours', ?, 'mcp', ?)
       ON CONFLICT(source_id, scope_key) DO UPDATE SET
         window_since = excluded.window_since, changed_via = 'mcp', changed_by_agent = excluded.changed_by_agent`,
    ).run(sourceId, WINDOW_SCOPE_KEY, windowSince, changedByAgent);
  });
}
