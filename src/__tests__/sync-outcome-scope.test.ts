/**
 * L7: a real sync outcome carries the scope it read under, because `source_synced` must name one
 * and a missing scope reports nothing. Driven through syncSource against a real graph file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetcherAuthError } from '@aligndottech/connector-core';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { syncSource } from '../lib/sync/run-source.js';
import { syncMeasurementOf } from '../lib/sync/telemetry.js';
import { type Harness, harness, pr } from './helpers/sync-env.js';

vi.setConfig({ testTimeout: 60_000 });
let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

describe('a sync outcome names its scope', () => {
  it('a completed read: yours, with the stored count', async () => {
    h.script({ items: [pr(1, '2026-10-09T00:00:00Z'), pr(2, '2026-10-09T01:00:00Z')] });
    const o = await syncSource('github', h.env);
    expect(o.scope).toBe('yours');
    expect(syncMeasurementOf(o, 'manual')).toMatchObject({ source: 'github', outcome: 'ok', scope: 'yours', count: o.created + o.updated });
  });
  it('a team-scope read says team', async () => {
    const env = { ...h.env, scopeOf: async () => ({ scopeKey: 'repo:acme/x', scope: 'team' as const, repo: 'acme/x' }) };
    h.script({ items: [pr(1, '2026-10-09T00:00:00Z')] });
    expect((await syncSource('github', env)).scope).toBe('team');
  });
  it('a refused token still names its scope (and reports needs_reauth)', async () => {
    h.script(new FetcherAuthError('GitHub'));
    const o = await syncSource('github', h.env);
    expect(o.state).toBe('needs_reauth');
    expect(syncMeasurementOf(o, 'background')).toMatchObject({ outcome: 'needs_reauth', scope: 'yours' });
  });
  it('a thrown error names its scope', async () => {
    h.script(new Error('boom'));
    const o = await syncSource('github', h.env);
    expect(syncMeasurementOf(o, 'manual')).toMatchObject({ outcome: 'error', scope: 'yours', count: 0 });
  });
  it('a source that is not connected reports nothing', async () => {
    const o = await syncSource('github', { ...h.env, tokens: () => null });
    expect(syncMeasurementOf(o, 'manual')).toBeUndefined();
  });
});
