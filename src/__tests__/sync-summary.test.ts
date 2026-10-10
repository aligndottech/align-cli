import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { buildSummary, readSummary, refreshSummary, SUMMARY_FILE, writeSummary } from '../lib/sync/summary.js';
import { beginRun, markNeedsReauth, saveRun } from '../lib/sync/sync-state.js';

/**
 * L5 Test List (sync-summary.json, Decision 8):
 * - One entry per CONNECTED source, with its worst status and latest success; a never-synced source reads "never"; Teams is not background-eligible.
 * - Written atomically with mode 0600; a missing, corrupt or foreign file reads as undefined (launch then spawns nothing).
 */
vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let dbPath: string;
const NOW = new Date('2026-10-10T12:00:00.000Z');
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-summary-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('buildSummary', () => {
  it('lists connected sources only, with status and last success', () => {
    const key = { source: 'github', scopeKey: 'yours', scope: 'yours' as const };
    beginRun(dbPath, key, null, NOW.toISOString());
    saveRun(dbPath, key, { status: 'ok', high_water: null, pending_until: null, items: 1, skips: [], successAt: '2026-10-10T11:00:00.000Z' });
    const s = buildSummary(dbPath, (id) => ['github', 'jira', 'teams'].includes(id), NOW);
    expect(s.sources).toEqual([
      { id: 'github', backgroundEligible: true, status: 'ok', lastSuccessAt: '2026-10-10T11:00:00.000Z' },
      { id: 'jira', backgroundEligible: true, status: 'never' },
      { id: 'teams', backgroundEligible: false, status: 'never' },
    ]);
  });

  it('the worst status across a source\'s scopes wins, and the latest success', () => {
    const a = { source: 'github', scopeKey: 'yours', scope: 'yours' as const };
    const b = { source: 'github', scopeKey: 'repo:o/r', scope: 'team' as const };
    beginRun(dbPath, a, null, NOW.toISOString());
    beginRun(dbPath, b, null, NOW.toISOString());
    saveRun(dbPath, a, { status: 'ok', high_water: null, pending_until: null, items: 1, skips: [], successAt: '2026-10-01T00:00:00.000Z' });
    saveRun(dbPath, b, { status: 'partial', high_water: null, pending_until: null, items: 1, skips: [], successAt: '2026-10-09T00:00:00.000Z' });
    expect(buildSummary(dbPath, (id) => id === 'github', NOW).sources[0]).toMatchObject({ status: 'partial', lastSuccessAt: '2026-10-09T00:00:00.000Z' });
    markNeedsReauth(dbPath, a, null, NOW.toISOString());
    expect(buildSummary(dbPath, (id) => id === 'github', NOW).sources[0]!.status).toBe('needs_reauth');
  });

  it('an unreadable last_success_at is ignored, not compared', () => {
    const key = { source: 'github', scopeKey: 'yours', scope: 'yours' as const };
    beginRun(dbPath, key, null, NOW.toISOString());
    saveRun(dbPath, key, { status: 'ok', high_water: null, pending_until: null, items: 1, skips: [], successAt: 'garbage' });
    expect(buildSummary(dbPath, () => true, NOW).sources.find((s) => s.id === 'github')).not.toHaveProperty('lastSuccessAt');
  });
});

describe('the file', () => {
  it('writes and reads back, mode 0600 off Windows, and leaves no temp file', () => {
    const sums = buildSummary(dbPath, (id) => id === 'github', NOW);
    expect(writeSummary(sums, dir)).toBe(true);
    expect(readSummary(dir)).toEqual(sums);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, SUMMARY_FILE)).mode & 0o777).toBe(0o600);
  });

  it('missing, corrupt, wrong-version and wrong-shape files read as undefined', () => {
    expect(readSummary(dir)).toBeUndefined();
    const f = path.join(dir, SUMMARY_FILE);
    for (const body of ['{not json', '{"version":2,"generated_at":"x","sources":[]}', '{"version":1,"sources":[]}', '[]', '{"version":1,"generated_at":"x","sources":"no"}']) {
      fs.writeFileSync(f, body);
      expect(readSummary(dir)).toBeUndefined();
    }
  });

  it('entries of the wrong shape are dropped rather than trusted', () => {
    fs.writeFileSync(path.join(dir, SUMMARY_FILE), JSON.stringify({ version: 1, generated_at: 'x', sources: [{ id: 'github', backgroundEligible: true, status: 'ok' }, { id: 5 }, null, { id: 'jira' }] }));
    expect(readSummary(dir)?.sources.map((s) => s.id)).toEqual(['github']);
  });

  it('refreshSummary reports false when it cannot write, and never throws', () => {
    expect(refreshSummary(dbPath, () => true, NOW, path.join(dir, 'no', 'such', 'dir'))).toBe(false);
    expect(refreshSummary(dbPath, () => true, NOW, dir)).toBe(true);
  });

  it('reading the graph for the summary never CREATES it: a missing graph file stays missing', () => {
    const missing = path.join(dir, 'missing.db');
    expect(refreshSummary(missing, (id) => id === 'github', NOW, dir)).toBe(true);
    expect(fs.existsSync(missing)).toBe(false);
    expect(readSummary(dir)?.sources).toEqual([{ id: 'github', backgroundEligible: true, status: 'never' }]);
  });
});
