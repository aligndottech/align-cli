import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { afterSourceConnected } from '../lib/sync/after-connect.js';
import { readSummary } from '../lib/sync/summary.js';
import { markNeedsReauth, readRows } from '../lib/sync/sync-state.js';

vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let dbPath: string;
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-after-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
  saved = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = path.join(dir, 'state');
});
afterEach(() => {
  if (saved === undefined) delete process.env['XDG_STATE_HOME']; else process.env['XDG_STATE_HOME'] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('afterSourceConnected', () => {
  it('clears needs_reauth for that source only, and lists it in the launch summary', () => {
    markNeedsReauth(dbPath, { source: 'github', scopeKey: 'yours', scope: 'yours' }, null, 'x');
    markNeedsReauth(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, null, 'x');
    afterSourceConnected(dbPath, 'github', (id) => id === 'github');
    expect(readRows(dbPath).map((r) => [r.source_id, r.status])).toEqual([['github', 'ok'], ['jira', 'needs_reauth']]);
    expect(readSummary(path.join(dir, 'state', 'align-cli'))?.sources.map((s) => s.id)).toEqual(['github']);
  });

  it('no graph file, or no path: nothing is created and nothing throws', () => {
    expect(() => afterSourceConnected(undefined, 'github', () => true)).not.toThrow();
    const missing = path.join(dir, 'nope.db');
    afterSourceConnected(missing, 'github', () => true);
    expect(fs.existsSync(missing)).toBe(false);
  });
});
