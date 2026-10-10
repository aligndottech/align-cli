import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { acquireLock } from '../lib/sync/lock.js';
import { runSync } from '../lib/sync/run-all.js';
import { type Harness, harness, pr } from './helpers/sync-env.js';

/**
 * L5 Test List (one invocation, many sources):
 * - Sources run one after another, each under its own lock; one held source does not stop the others.
 * - The re-link queue runs ONCE per invocation, after the sources, under its own lock; if another process holds it, this one skips it.
 * - Every outcome is reported as it lands.
 */
vi.setConfig({ testTimeout: 60_000 });
let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const unfinish = () => { const db = new DatabaseSync(h.dbPath); try { db.exec('UPDATE decisions SET enriched_at = NULL'); } finally { db.close(); } };

describe('runSync', () => {
  it('runs each source in order, reports each outcome as it lands, and relinks once afterwards', async () => {
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z')] });
    await runSync(['github'], h.env);
    unfinish();
    h.script({ items: [] });
    const seen: string[] = [];
    const relink = vi.spyOn(h.env.client, 'relinkUnfinished');
    const r = await runSync(['github', 'jira'], h.env, { trigger: 'cli', onOutcome: (o) => seen.push(`${o.source}:${o.state}`) });
    expect(seen).toEqual(['github:ok', 'jira:ok']);
    expect(r.outcomes.map((o) => o.source)).toEqual(['github', 'jira']);
    // the github run's own ingest saw the row unchanged-but-unfinished and the queue finished whatever was left
    expect(relink.mock.calls.length).toBeLessThanOrEqual(1);
    expect(r.relink).toMatchObject({ timedOut: false });
    const left = new DatabaseSync(h.dbPath);
    try { expect(left.prepare('SELECT 1 FROM decisions WHERE enriched_at IS NULL').all()).toHaveLength(0); } finally { left.close(); }
  });

  it('a source held by another process does not stop the others', async () => {
    acquireLock('sync-github', { dir: h.lockDir, pid: 4242, alive: () => true });
    h.script({ items: [] });
    const r = await runSync(['github', 'jira'], h.env);
    expect(r.outcomes.map((o) => `${o.source}:${o.state}`)).toEqual(['github:locked', 'jira:ok']);
    expect(h.fetchCalls.map((c) => c.source)).toEqual(['jira']);
  });

  it('the re-link lock held elsewhere: this invocation skips the queue and says nothing was relinked', async () => {
    acquireLock('sync-relink', { dir: h.lockDir, pid: 4242, alive: () => true });
    h.script({ items: [] });
    const relink = vi.spyOn(h.env.client, 'relinkUnfinished');
    const r = await runSync(['github'], h.env);
    expect(r.relink).toBeUndefined();
    expect(relink).not.toHaveBeenCalled();
  });

  it('no sources at all still finishes the re-link queue (the post-upgrade repair needs no connected source)', async () => {
    h.script({ items: [pr(1, '2026-10-05T00:00:00.000Z')] });
    await runSync(['github'], h.env);
    unfinish();
    const r = await runSync([], h.env);
    expect(r.outcomes).toEqual([]);
    expect(r.relink?.linked).toBe(1);
  });

  it('a re-link queue that throws is REPORTED, not thrown: the sources already synced stay recorded, and the lock is released', async () => {
    h.script({ items: [] });
    const boom = { ...h.env, client: { ...h.env.client, relinkUnfinished: async () => { throw new Error('boom'); } } };
    unfinish();
    const db = new DatabaseSync(h.dbPath);
    db.exec(`INSERT INTO decisions (id, title, summary, platform, source_url) VALUES ('x', 'x', 's', 'github', 'https://github.com/o/r/pull/5')`);
    db.close();
    const r = await runSync([], boom);
    expect(r.relinkError).toBe('boom');
    expect(r.relink).toBeUndefined();
    expect(acquireLock('sync-relink', { dir: h.lockDir, alive: () => true }).ok).toBe(true);
  });
});
