import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const embedCalls: string[] = [];
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (t: string) => {
    embedCalls.push(t);
    // Items about the same topic embed close together, so the link pass has something to link.
    const v = new Float32Array(384).fill(0.01);
    v[t.includes('Postgres') ? 0 : 1] = 1;
    return v;
  }),
  cosineSimilarity: vi.fn((a: Float32Array, b: Float32Array) => (a[0] === b[0] ? 0.95 : 0.05)),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { relinkAll } from '../lib/sync/relink.js';

/**
 * L5 Test List (re-link queue, Decision 30):
 * - Given 40 rows with enriched_at NULL that already hold embeddings, the run re-links them with 0 embed calls and stamps enriched_at.
 * - Given 0 such rows, no re-link work (no matrix load, no embed).
 * - A row whose embedding is gone is re-ingested from its stored text (1 embed call) and keeps its identity (no twin).
 * - A row with no URL and no embedding cannot be re-ingested without a twin: it is counted skipped, left, and does not loop the queue.
 * - The queue is oldest first, and a deadline stops it cleanly.
 */
vi.setConfig({ testTimeout: 60_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-relink-'));
  dbPath = path.join(dir, 'graph.db');
  embedCalls.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sql<T = Record<string, unknown>>(q: string): T[] {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(q).all() as T[]; } finally { db.close(); }
}
function exec(q: string): void { const db = new DatabaseSync(dbPath); try { db.exec(q); } finally { db.close(); } }

async function seed(n: number): Promise<void> {
  const c = createLocalGatewayClient(dbPath);
  await c.ingestBatch(Array.from({ length: n }, (_, i) => ({
    source_url: `https://github.com/o/r/pull/${i + 1}`, platform: 'github', title: `PR ${i + 1}`, raw_text: `Use Postgres for store ${i + 1}`,
  })), { classify: false, keyed: true });
  c.close();
}
const links = () => Number((sql<{ n: number }>('SELECT COUNT(*) AS n FROM decision_links')[0] as { n: number }).n);

describe('relinkAll', () => {
  it('40 unfinished rows that hold embeddings: linked with ZERO embed calls, and stamped', async () => {
    await seed(40);
    exec('DELETE FROM decision_links; UPDATE decisions SET enriched_at = NULL');
    embedCalls.length = 0;
    const c = createLocalGatewayClient(dbPath);
    const r = await relinkAll(dbPath, c);
    c.close();
    expect(r).toMatchObject({ linked: 40, embedded: 0, skipped: 0 });
    expect(embedCalls).toHaveLength(0);
    expect(sql('SELECT 1 FROM decisions WHERE enriched_at IS NULL')).toHaveLength(0);
    expect(links()).toBeGreaterThan(0); // the links the unfinished ingest never wrote
  });

  it('a second example, a different size: 7 rows', async () => {
    await seed(7);
    exec('DELETE FROM decision_links; UPDATE decisions SET enriched_at = NULL');
    const c = createLocalGatewayClient(dbPath);
    expect((await relinkAll(dbPath, c)).linked).toBe(7);
    c.close();
  });

  it('nothing unfinished: no work at all', async () => {
    await seed(5);
    embedCalls.length = 0;
    const c = createLocalGatewayClient(dbPath);
    const spy = vi.spyOn(c, 'relinkUnfinished');
    const r = await relinkAll(dbPath, c);
    c.close();
    expect(r).toEqual({ linked: 0, embedded: 0, skipped: 0, timedOut: false });
    expect(spy).not.toHaveBeenCalled();
    expect(embedCalls).toHaveLength(0);
  });

  it('a row whose embedding is gone is re-ingested from its stored text: one embed call, same row, no twin', async () => {
    await seed(3);
    const before = sql<{ id: string }>(`SELECT id FROM decisions WHERE title = 'PR 2'`)[0]!.id;
    exec(`UPDATE decisions SET enriched_at = NULL WHERE title = 'PR 2'; DELETE FROM decision_embeddings WHERE decision_id = '${before}'`);
    embedCalls.length = 0;
    const c = createLocalGatewayClient(dbPath);
    const r = await relinkAll(dbPath, c);
    c.close();
    expect(r).toMatchObject({ linked: 0, embedded: 1 });
    expect(embedCalls).toHaveLength(1);
    expect(sql<{ id: string }>(`SELECT id FROM decisions WHERE title = 'PR 2'`)).toEqual([{ id: before }]);
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(3);
    expect(sql(`SELECT 1 FROM decisions WHERE id = '${before}' AND enriched_at IS NOT NULL`)).toHaveLength(1);
  });

  it('a row with no URL and no embedding is skipped, left unfinished, and the queue still ends', async () => {
    await seed(2);
    exec(`INSERT INTO decisions (id, title, summary, platform) VALUES ('orphan', 'plain note', 'Use Postgres', 'cli')`);
    const c = createLocalGatewayClient(dbPath);
    const r = await relinkAll(dbPath, c);
    c.close();
    // The query itself leaves the unservable row out, so it is neither embedded nor looped on.
    expect(r).toMatchObject({ embedded: 0, skipped: 0 });
    expect(sql(`SELECT 1 FROM decisions WHERE id = 'orphan' AND enriched_at IS NULL`)).toHaveLength(1);
    expect(embedCalls.filter((t) => t.includes('plain note'))).toHaveLength(0);
  });

  it('a row the client handled but did not stamp is not handed over again (the queue cannot spin)', async () => {
    await seed(3);
    exec('UPDATE decisions SET enriched_at = NULL');
    const handed: string[] = [];
    const lazy = { relinkUnfinished: async (rows: Array<{ id: string; keyed: boolean }>) => { if (handed.length > 20) throw new Error('the queue handed the same rows over again'); handed.push(...rows.map((r) => r.id)); return { linked: rows.length, embedded: 0, skipped: 0 }; } };
    const r = await relinkAll(dbPath, lazy);
    expect(r.linked).toBe(3);
    expect(new Set(handed).size).toBe(handed.length);
  }, 5_000);

  it('a row still waiting for its discussion keeps that flag through the full re-ingest (it was reset to 0 before)', async () => {
    await seed(2);
    const id = sql<{ id: string }>(`SELECT id FROM decisions WHERE title = 'PR 1'`)[0]!.id;
    exec(`UPDATE decisions SET enriched_at = NULL, detail_pending = 1 WHERE id = '${id}'; DELETE FROM decision_embeddings WHERE decision_id = '${id}'`);
    const c = createLocalGatewayClient(dbPath);
    expect(await relinkAll(dbPath, c)).toMatchObject({ embedded: 1 });
    c.close();
    expect(sql<{ detail_pending: number }>(`SELECT detail_pending FROM decisions WHERE id = '${id}'`)[0]!.detail_pending).toBe(1);
    expect(sql<{ detail_pending: number }>(`SELECT detail_pending FROM decisions WHERE title = 'PR 2'`)[0]!.detail_pending).toBe(0);
  });

  it('a long run of handled-but-unstamped rows at the head of the queue does not end it early (batch 2, 6 rows, the first 4 never get stamped)', async () => {
    await seed(6);
    exec('UPDATE decisions SET enriched_at = NULL');
    const handed: string[] = [];
    const real = createLocalGatewayClient(dbPath);
    const stubborn = new Set(sql<{ id: string }>('SELECT id FROM decisions ORDER BY created_at, rowid LIMIT 4').map((r) => r.id));
    const client = {
      relinkUnfinished: async (rows: Array<{ id: string; keyed: boolean; pending?: boolean }>) => {
        handed.push(...rows.map((r) => r.id));
        return real.relinkUnfinished(rows.filter((r) => !stubborn.has(r.id)));
      },
    };
    await relinkAll(dbPath, client, { batch: 2 });
    real.close();
    expect(new Set(handed).size).toBe(6);
    expect(sql('SELECT 1 FROM decisions WHERE enriched_at IS NULL')).toHaveLength(4);
  });

  it('oldest first: with a one-row batch the first row handled is the oldest', async () => {
    await seed(3);
    exec(`UPDATE decisions SET enriched_at = NULL, created_at = '2026-01-0' || (CAST(substr(title, 4) AS INTEGER)) || ' 00:00:00'`);
    const seen: string[] = [];
    const c = createLocalGatewayClient(dbPath);
    const real = c.relinkUnfinished.bind(c);
    const wrapped = { relinkUnfinished: async (rows: Array<{ id: string; keyed: boolean }>) => { seen.push(...rows.map((r) => sql<{ title: string }>(`SELECT title FROM decisions WHERE id = '${r.id}'`)[0]!.title)); return real(rows); } };
    await relinkAll(dbPath, wrapped, { batch: 1 });
    c.close();
    expect(seen).toEqual(['PR 1', 'PR 2', 'PR 3']);
  });

  it('a deadline already passed stops before any work and says so', async () => {
    await seed(3);
    exec('UPDATE decisions SET enriched_at = NULL');
    const c = createLocalGatewayClient(dbPath);
    const r = await relinkAll(dbPath, c, { deadlineAt: 1_000, now: () => 2_000 });
    c.close();
    expect(r).toMatchObject({ linked: 0, timedOut: true });
    expect(sql('SELECT 1 FROM decisions WHERE enriched_at IS NULL')).toHaveLength(3);
  });
});
