import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { backfillDir, statusPath, writeStatus } from '../lib/backfill-state.js';
import type { createConfigStore } from '../lib/config.js';
import { localGraphPath, realStatusDeps, realSyncEnv } from '../lib/sync/real-env.js';

/**
 * L5: the production wiring. A fake config store and a scratch state directory stand in for the
 * person's machine; nothing here opens the real graph or the real config.
 */
vi.setConfig({ testTimeout: 30_000 });
type Config = ReturnType<typeof createConfigStore>;
let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-realenv-'));
  saved = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = path.join(dir, 'state');
});
afterEach(() => {
  if (saved === undefined) delete process.env['XDG_STATE_HOME']; else process.env['XDG_STATE_HOME'] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});
const config = (fields: Record<string, Record<string, string>>, env: Record<string, unknown> = { mode: 'local-embedded', localDbPath: '/x/graph.db' }): Config =>
  ({ getConnectorFields: (_e: string, id: string) => fields[id] ?? null, getEnvironment: () => env }) as unknown as Config;

describe('localGraphPath', () => {
  it('the local graph when local mode is on, undefined otherwise (never invents one)', () => {
    expect(localGraphPath(config({}))).toBe('/x/graph.db');
    expect(localGraphPath(config({}, { mode: 'auth' }))).toBeUndefined();
  });
});

describe('realSyncEnv', () => {
  it('tokens come from the local connector store, whole (the extra fields too)', () => {
    const env = realSyncEnv(path.join(dir, 'graph.db'), config({ jira: { token: 't', domain: 'x.atlassian.net' } }));
    try {
      expect(env.tokens('jira')).toEqual({ token: 't', domain: 'x.atlassian.net' });
      expect(env.tokens('github')).toBeNull();
    } finally { (env.client as unknown as { close(): void }).close(); }
  });

  it('a live backfill of a source blocks a sync of that source only; a dead one or a finished one does not', () => {
    const d = backfillDir()!;
    writeStatus(statusPath(d, 'github'), { source: 'github', pid: process.pid, started_at: new Date().toISOString(), state: 'running' });
    writeStatus(statusPath(d, 'slack'), { source: 'slack', pid: 2_000_000_000, started_at: new Date().toISOString(), state: 'running' });
    writeStatus(statusPath(d, 'jira'), { source: 'jira', pid: process.pid, started_at: new Date().toISOString(), state: 'done' });
    const env = realSyncEnv(path.join(dir, 'graph.db'), config({}));
    try {
      expect(env.backfillRunning('github')).toBe(true);
      expect(env.backfillRunning('slack')).toBe(false);
      expect(env.backfillRunning('jira')).toBe(false);
      expect(env.backfillRunning('linear')).toBe(false);
    } finally { (env.client as unknown as { close(): void }).close(); }
  });

  it('the lock it hands out is the real per-source lock: a second taker is refused', () => {
    const env = realSyncEnv(path.join(dir, 'graph.db'), config({}));
    try {
      const a = env.lock('sync-github');
      expect(a.ok).toBe(true);
      expect(env.lock('sync-github').ok).toBe(false);
      if (a.ok) a.release();
      expect(env.lock('sync-github').ok).toBe(true);
    } finally { (env.client as unknown as { close(): void }).close(); }
  });
});

describe('realStatusDeps', () => {
  it('connected means a token is saved; a lock held by a live process means the sync is running', () => {
    const env = realSyncEnv(path.join(dir, 'graph.db'), config({}));
    try {
      const deps = realStatusDeps(path.join(dir, 'graph.db'), config({ github: { token: 't' }, slack: { domain: 'no-token' } }));
      expect(deps.isConnected('github')).toBe(true);
      expect(deps.isConnected('slack')).toBe(false);
      expect(deps.syncRunning('github')).toBe(false);
      const l = env.lock('sync-github');
      expect(deps.syncRunning('github')).toBe(true);
      if (l.ok) l.release();
      expect(deps.syncRunning('github')).toBe(false);
    } finally { (env.client as unknown as { close(): void }).close(); }
  });
});
