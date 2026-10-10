// L2, Decision 30: an ingest is "done" only when its link pass finished. ingestOne writes
// decisions.enriched_at as its LAST write, and the unchanged-skip (#355) requires it. So an
// ingest that died between storing the embedding and writing the links is retried by the
// next run, and the retry does only the missing work.
//
// The crash is manufactured at the DB boundary: the link writer throws once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as LocalDb from '../lib/local-db.js';
import type * as RepoIdentity from '../lib/repo-identity.js';

const writes: string[] = [];
const failNext = { insertLink: false };

vi.mock('../lib/local-db.js', async (importOriginal) => {
  const real = await importOriginal<typeof LocalDb>();
  return {
    ...real,
    createLocalDb: (p: string) => {
      const db = real.createLocalDb(p);
      const record = <K extends 'insertDecision' | 'setEmbedding' | 'insertLink' | 'replaceLink' | 'markEnriched'>(name: K) => {
        const orig = db[name] as (...a: unknown[]) => unknown;
        (db as Record<string, unknown>)[name] = (...args: unknown[]) => {
          if (name === 'insertLink' && failNext.insertLink) {
            failNext.insertLink = false;
            throw new Error('killed mid link pass');
          }
          writes.push(name);
          return orig(...args);
        };
      };
      for (const n of ['insertDecision', 'setEmbedding', 'insertLink', 'replaceLink', 'markEnriched'] as const) record(n);
      return db;
    },
  };
});

// Ranking is driven by the mocked cosineSimilarity below; see helpers/mocked-cosine-matrix.ts.
vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.8),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

vi.mock('../lib/repo-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RepoIdentity>()),
  currentRepoIdentity: vi.fn().mockResolvedValue(null),
}));

import { PROVIDER_ENV_VARS } from '../lib/llm-providers.js';
import { getEmbedding } from '../lib/local-embeddings.js';
import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { isUnchanged } from '../lib/local-ingest.js';

const A = { source_url: 'https://github.com/o/r/pull/1', platform: 'github', title: 'Use Postgres for the queue', raw_text: 'Use Postgres for the queue; Redis loses jobs on restart.' };
const B = { source_url: 'https://github.com/o/r/pull/2', platform: 'github', title: 'Queue retries cap at 5', raw_text: 'Queue retries cap at 5 with backoff.' };

describe('isUnchanged requires a finished link pass', () => {
  const row = { title: 'T', summary: 's', platform: 'github', repo: null, decidedAt: null };
  const next = { title: 'T', summary: 's', platform: 'github', repo: null, decidedAt: null };
  it('true with enriched_at set', () => {
    expect(isUnchanged(row, next, 'm', 'm', '2026-10-10T00:00:00.000Z')).toBe(true);
  });
  it('false with enriched_at NULL', () => {
    expect(isUnchanged(row, next, 'm', 'm', null)).toBe(false);
  });
  it('false when only the title changed (a retitled item keyed by source_key)', () => {
    expect(isUnchanged(row, { ...next, title: 'T2' }, 'm', 'm', '2026-10-10T00:00:00.000Z')).toBe(false);
  });
});

describe('ingestOne writes enriched_at last, and a crashed ingest is retried with only the missing steps', () => {
  let scratch: string;
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    for (const k of PROVIDER_ENV_VARS) vi.stubEnv(k, undefined);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l2-enriched-'));
    vi.stubEnv('HOME', scratch);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(scratch, '.config'));
    dbPath = path.join(scratch, 'local.db');
    client = createLocalGatewayClient(dbPath);
    vi.mocked(getEmbedding).mockClear();
    writes.length = 0;
    failNext.insertLink = false;
  });

  afterEach(() => {
    client.close();
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function inspect<T>(fn: (db: ReturnType<typeof createLocalDb>) => T): T {
    const db = createLocalDb(dbPath);
    try { return fn(db); } finally { db.close(); }
  }

  it('a fresh ingest sets enriched_at, and it is the last write', async () => {
    await client.ingestBatch([B], { classify: false });
    writes.length = 0;
    const { snapshots } = await client.ingestBatch([A], { classify: false });

    expect(inspect(db => db.getEnrichedAt(snapshots[0].id))).not.toBeNull();
    expect(writes).toContain('insertLink'); // control: a link pass ran
    expect(writes[writes.length - 1]).toBe('markEnriched');
    expect(writes.filter(w => w === 'markEnriched')).toHaveLength(1);
  });

  it('dies in the link pass: the embedding exists and enriched_at stays NULL; the retry links without embedding', async () => {
    await client.ingestBatch([B], { classify: false });
    failNext.insertLink = true;
    await expect(client.ingestBatch([A], { classify: false })).rejects.toThrow('killed mid link pass');
    const id = inspect(db => db.findIdBySource(A.source_url, A.title, 'github'))!;
    expect(id).toBeTruthy();
    expect(inspect(db => db.getEmbedding(id))).not.toBeNull();
    expect(inspect(db => db.getEnrichedAt(id))).toBeNull();
    expect(inspect(db => db.listLinks({ decisionId: id }))).toHaveLength(0);
    vi.mocked(getEmbedding).mockClear();
    writes.length = 0;

    const { snapshots } = await client.ingestBatch([A], { classify: false });

    expect(getEmbedding).not.toHaveBeenCalled();
    expect(writes).not.toContain('insertDecision');
    expect(writes).not.toContain('setEmbedding');
    expect(inspect(db => db.listLinks({ decisionId: id })).length).toBeGreaterThan(0);
    expect(inspect(db => db.getEnrichedAt(id))).not.toBeNull();
    expect(writes[writes.length - 1]).toBe('markEnriched');
    expect(snapshots[0]).toMatchObject({ id, created: false, changed: false });
  });

  it('unchanged text, enriched_at NULL, and NO embedding: one embed call, then the link pass', async () => {
    await client.ingestBatch([B, A], { classify: false });
    const id = inspect(db => db.findIdBySource(A.source_url, A.title, 'github'))!;
    // Stand-in for a row whose ingest died before its embedding was stored.
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE decisions SET enriched_at = NULL WHERE id = ?').run(id);
    raw.prepare('DELETE FROM decision_embeddings WHERE decision_id = ?').run(id);
    raw.close();
    vi.mocked(getEmbedding).mockClear();

    await client.ingestBatch([A], { classify: false });

    expect(getEmbedding).toHaveBeenCalledTimes(1);
    expect(inspect(db => db.getEnrichedAt(id))).not.toBeNull();
    expect(inspect(db => db.listLinks({ decisionId: id })).length).toBeGreaterThan(0);
  });

  it('a changed text runs the full ingest whatever enriched_at says', async () => {
    await client.ingestBatch([A], { classify: false });
    vi.mocked(getEmbedding).mockClear();

    const { snapshots } = await client.ingestBatch([{ ...A, raw_text: `${A.raw_text} Revised.` }], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    expect(getEmbedding).toHaveBeenCalledTimes(1);
  });

  it('unchanged and enriched: no work at all (the #355 skip, kept)', async () => {
    await client.ingestBatch([A, B], { classify: false });
    vi.mocked(getEmbedding).mockClear();
    writes.length = 0;

    const { snapshots } = await client.ingestBatch([A, B], { classify: false });

    expect(getEmbedding).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(snapshots.map(s => s.changed)).toEqual([false, false]);
  });

  // Both upsert branches: a keyed item (source_key) and a keyless one ((source_url, title)).
  const DOC = { source_url: 'https://github.com/o/r/blob/main/docs/adr/0001.md', platform: 'docs', title: 'ADR 1: queue', raw_text: 'Use Postgres for the queue.' };
  it.each([['keyed', A], ['keyless', DOC]])('a changed text that dies in the link pass leaves enriched_at NULL (%s row), so the next run is not skipped', async (_kind, A) => {
    await client.ingestBatch([B, A], { classify: false });
    const id = inspect(db => db.findIdBySource(A.source_url, A.title, A.platform))!;
    expect(inspect(db => db.getEnrichedAt(id))).not.toBeNull(); // control: it was enriched
    failNext.insertLink = true;
    const revised = { ...A, raw_text: `${A.raw_text} Revised.` };
    await expect(client.ingestBatch([revised], { classify: false })).rejects.toThrow();

    expect(inspect(db => db.getEnrichedAt(id))).toBeNull();
    vi.mocked(getEmbedding).mockClear();
    await client.ingestBatch([revised], { classify: false });
    expect(getEmbedding).not.toHaveBeenCalled();
    expect(inspect(db => db.getEnrichedAt(id))).not.toBeNull();
  });

  // The embed runs BEFORE the row is rewritten. Otherwise a failed embed would leave the new
  // text beside the OLD text's vector, and the retry above would link that stale vector
  // without ever re-embedding.
  it('an embed that fails on a changed text writes nothing, so the next run re-embeds', async () => {
    await client.ingestBatch([B, A], { classify: false });
    const id = inspect(db => db.findIdBySource(A.source_url, A.title, 'github'))!;
    const revised = { ...A, raw_text: `${A.raw_text} Revised.` };
    vi.mocked(getEmbedding).mockRejectedValueOnce(new Error('model download failed'));
    await expect(client.ingestBatch([revised], { classify: false })).rejects.toThrow('model download failed');

    expect(inspect(db => db.getDecisionById(id)?.summary)).toBe(A.raw_text);
    expect(inspect(db => db.getEnrichedAt(id))).not.toBeNull();
    vi.mocked(getEmbedding).mockClear();
    await client.ingestBatch([revised], { classify: false });
    expect(getEmbedding).toHaveBeenCalledTimes(1);
    expect(inspect(db => db.getDecisionById(id)?.summary)).toBe(revised.raw_text);
  });

  it('a retitled item (same source_key) updates the one row, and is a change', async () => {
    await client.ingestBatch([A], { classify: false, keyed: true });
    const { snapshots } = await client.ingestBatch([{ ...A, title: 'Use Postgres, not Redis, for the queue' }], { classify: false, keyed: true });

    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    expect(inspect(db => db.listDecisions().map(d => d.title))).toEqual(['Use Postgres, not Redis, for the queue']);
  });

  it('human capture (classify not false) still sets enriched_at', async () => {
    const r = await client.captureDecision('Pin node 22 in CI', 'cli');
    expect(inspect(db => db.getEnrichedAt(r.id))).not.toBeNull();
  });
});
