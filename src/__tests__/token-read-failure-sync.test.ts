import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';
import { syncSource } from '../lib/sync/run-source.js';
import { buildSummary } from '../lib/sync/summary.js';
import { harness, type Harness } from './helpers/sync-env.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

describe('a token that could not be read is not a source that is not connected', () => {
  it('a read failure skips the source and does not call it not_connected', async () => {
    const env = { ...h.env, tokens: () => null, tokenReadFailed: () => true };
    const out = await syncSource('github', env);
    expect(out.state).toBe('skipped');
    expect(out.message).toMatch(/could not read|keychain|credential store/i);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('a source that is truly absent is still not_connected', async () => {
    const out = await syncSource('github', { ...h.env, tokens: () => null, tokenReadFailed: () => false });
    expect(out.state).toBe('not_connected');
  });

  it('the summary keeps a source whose token read failed', () => {
    createLocalDb(h.dbPath).close();
    const summary = buildSummary(h.dbPath, (id) => id === 'github', new Date('2026-10-10T12:00:00Z'));
    expect(summary.sources.map((s) => s.id)).toEqual(['github']);
  });
});
