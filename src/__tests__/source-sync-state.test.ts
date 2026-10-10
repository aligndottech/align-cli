import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { readSyncStatus, recordWindowSince, WINDOW_SCOPE_KEY } from '../lib/source-sync-state.js';

/**
 * L3: the part of source_sync that `align_backfill` needs before L5 exists - read whether a source
 * needs re-authentication, and record the window the user asked for. L5 owns the watermark.
 */
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-sync-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function rows(): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare('SELECT * FROM source_sync ORDER BY source_id, scope_key').all() as never; } finally { db.close(); }
}
function seed(sourceId: string, scopeKey: string, status: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope, status) VALUES (?, ?, 'yours', ?)`).run(sourceId, scopeKey, status);
  } finally { db.close(); }
}

describe('readSyncStatus', () => {
  it('a source with no row has no problem', () => {
    expect(readSyncStatus(dbPath, 'github')).toEqual({ needsReauth: false });
  });

  it('needs_reauth on ANY scope of the source counts, and only that source', () => {
    seed('github', 'repo:o/r', 'needs_reauth');
    seed('jira', 'jira:ALI', 'ok');
    expect(readSyncStatus(dbPath, 'github')).toEqual({ needsReauth: true });
    expect(readSyncStatus(dbPath, 'jira')).toEqual({ needsReauth: false });
  });

  it('a partial or errored run is not a reason to stop (only auth is)', () => {
    seed('slack', 'yours', 'partial');
    seed('linear', 'yours', 'error');
    expect(readSyncStatus(dbPath, 'slack').needsReauth).toBe(false);
    expect(readSyncStatus(dbPath, 'linear').needsReauth).toBe(false);
  });
});

describe('recordWindowSince', () => {
  it('writes the window, attributes it to the agent, and leaves watermark columns empty', () => {
    recordWindowSince(dbPath, 'github', '2025-10-10T12:00:00.000Z', 'unknown');
    expect(rows()).toEqual([expect.objectContaining({
      source_id: 'github', scope_key: WINDOW_SCOPE_KEY, scope: 'yours', window_since: '2025-10-10T12:00:00.000Z',
      high_water: null, pending_until: null, status: 'ok', changed_via: 'mcp', changed_by_agent: 'unknown',
    })]);
  });

  it('a second request for the same source replaces the window and does not add a row', () => {
    recordWindowSince(dbPath, 'github', '2025-10-10T12:00:00.000Z', 'unknown');
    recordWindowSince(dbPath, 'github', '2026-09-10T12:00:00.000Z', 'unknown');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ window_since: '2026-09-10T12:00:00.000Z' });
  });

  it('"all" is a NULL window, not the string "null"', () => {
    recordWindowSince(dbPath, 'jira', null, 'unknown');
    expect(rows()[0]!['window_since']).toBeNull();
  });

  it('never touches a row L5 owns: a stored watermark and status survive a new window', () => {
    const db = new DatabaseSync(dbPath);
    db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope, high_water, status, last_success_at) VALUES ('slack', ?, 'yours', 'H', 'partial', 'T')`).run(WINDOW_SCOPE_KEY);
    db.close();
    recordWindowSince(dbPath, 'slack', '2026-01-01T00:00:00.000Z', 'unknown');
    expect(rows()[0]).toMatchObject({ window_since: '2026-01-01T00:00:00.000Z', high_water: 'H', status: 'partial', last_success_at: 'T', changed_via: 'mcp' });
  });
});
