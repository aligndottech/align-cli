// LB: ingest ranks each new item against the whole graph through an in-memory matrix. The
// matrix is a speed change and nothing else, so its links must equal the exhaustive scan's
// EXACTLY - ids, order and the bit pattern of every score - including against rows added
// earlier in the same batch, which the matrix learns by append and not by reload.
import type * as Embeddings from '../lib/local-embeddings.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.setConfig({ testTimeout: 30_000 });
const DIM = 32;
let seed = 777;
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
const centres = Array.from({ length: 12 }, () => Float32Array.from({ length: DIM }, () => rand() * 2));
// "cN-nM" text -> cluster N's centre plus noise keyed by M. Deliberately not unit length.
function vectorFor(text: string): Float32Array {
  const m = /c(\d+)-n(\d+)/.exec(text)!;
  const c = centres[Number(m[1])]!;
  let s = Number(m[2]) * 2654435761 >>> 0;
  return Float32Array.from(c, (x) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return x + (s / 2 ** 32 - 0.5) * 1.6; });
}

vi.mock('../lib/local-embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Embeddings>()),
  getEmbedding: vi.fn(async (text: string) => vectorFor(text)),
}));

import { cosineSimilarity, EMBEDDING_MODEL_ID } from '../lib/local-embeddings.js';
import { createLocalDb } from '../lib/local-db.js';
import { DatabaseSync } from 'node:sqlite';
import { connectorItemKey } from '../lib/source-key.js';
import { SLACK_TOMBSTONE_TITLE } from '../lib/local-db-migrate.js';
import { createLocalGatewayClient, RELATED_FLOOR, RELATED_TOP_K, SIMILARITY_THRESHOLD } from '../lib/local-gateway-client.js';

describe('ingest similarity: matrix result equals the exhaustive scan', () => {
  let dbPath: string;
  beforeEach(() => { dbPath = path.join(os.tmpdir(), `align-lb-parity-${process.pid}-${Math.trunc(performance.now() * 1000)}.db`); });
  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  });

  it('returns the same links, in the same order with the same scores, for 20 items over 500 stored rows', async () => {
    const seedDb = createLocalDb(dbPath);
    const stored: Array<{ id: string; vec: Float32Array }> = [];
    for (let i = 0; i < 500; i++) {
      const vec = vectorFor(`c${i % 12}-n${i}`);
      const id = seedDb.insertDecision({ title: `seed ${i}`, summary: `seed ${i}`, sourceUrl: `https://seed.test/${i}`, platform: 'github' });
      seedDb.setEmbedding(id, vec, EMBEDDING_MODEL_ID);
      stored.push({ id, vec });
    }
    seedDb.close();

    // Item 19 shares item 2's cluster and noise: it must find item 2, a row that only the
    // append path knows about.
    const items = Array.from({ length: 20 }, (_, j) => {
      const k = j === 19 ? 2 : j;
      const tag = `c${(k * 5) % 12}-n${900 + k}`;
      return { platform: 'slack', source_url: `https://new.test/${j}`, title: tag, raw_text: `${tag} body ${j}` };
    });
    const client = createLocalGatewayClient(dbPath);
    const { snapshots } = await client.ingestBatch(items, { classify: false, keyed: true });
    client.close();
    expect(snapshots).toHaveLength(20);

    const rows = stored.slice();
    let linked = 0;
    items.forEach((item, j) => {
      const q = vectorFor(`${item.title}. ${item.raw_text}`);
      const id = snapshots[j]!.id;
      const ranked = rows
        .map((r) => ({ decisionId: r.id, score: cosineSimilarity(q, r.vec) }))
        .filter((e) => e.score >= 0)
        .sort((a, b) => b.score - a.score || (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0))
        .slice(0, 10)
        .filter((c, i) => c.score >= SIMILARITY_THRESHOLD || (i < RELATED_TOP_K && c.score >= RELATED_FLOOR));
      const got = snapshots[j]!.analysis.relatedDecisions.map((r: { id: string; confidence: number }) => ({ decisionId: r.id, score: r.confidence }));
      expect(got, `item ${j}`).toEqual(ranked);
      linked += ranked.length;
      rows.push({ id, vec: q });
    });
    // The fixture must exercise linking, or equality of two empty lists proves nothing.
    expect(linked).toBeGreaterThan(40);
    // Item 19 is item 2's twin, so it links to a batch-mate and not only to seeded rows.
    const batchIds = new Set(snapshots.map((s) => s.id));
    expect(snapshots[19]!.analysis.relatedDecisions.some((r: { id: string }) => batchIds.has(r.id))).toBe(true);
  });

  it('does not link to a Slack tombstone twin that the same run deletes', async () => {
    // A matrix loaded before the twin goes would still hold its vector and link the new
    // thread to a decision that no longer exists. The run must see the deletion.
    const seedDb = createLocalDb(dbPath);
    const twinVec = vectorFor('c4-n950');
    const twinId = seedDb.insertDecision({ title: SLACK_TOMBSTONE_TITLE, summary: 'tombstone', sourceUrl: 'https://slack.test/t/1', platform: 'slack' });
    seedDb.setEmbedding(twinId, twinVec, EMBEDDING_MODEL_ID);
    seedDb.close();

    const client = createLocalGatewayClient(dbPath);
    const { snapshots } = await client.ingestBatch([
      { platform: 'github', source_url: 'https://new.test/a', title: 'c4-n951', raw_text: 'c4-n951 loads the matrix first' },
      { platform: 'slack', source_url: 'https://slack.test/t/1', title: 'c4-n950', raw_text: 'c4-n950 the thread under its real title' },
    ], { classify: false, keyed: true });
    client.close();

    const ids = snapshots[1]!.analysis.relatedDecisions.map((r: { id: string }) => r.id);
    expect(ids).toContain(snapshots[0]!.id);   // control: the cluster mate IS linked
    expect(ids).not.toContain(twinId);
    const check = createLocalDb(dbPath);
    expect(check.getDecisionById(twinId)).toBeNull();
    expect(check.listLinks().filter((l) => l.sourceId === twinId || l.targetId === twinId)).toEqual([]);
    check.close();
  });

  it('does not link to a keyless twin that the same run folds into its keyed holder', async () => {
    // Same hazard as the tombstone case, through foldPendingTwin: the twin's vector is deleted
    // mid-run, so a matrix loaded earlier in the run must not still offer it.
    const PR = 'https://github.com/o/r/pull/9';
    const seedDb = createLocalDb(dbPath);
    const twinId = seedDb.insertDecision({ title: 'New title', summary: 'twin body', sourceUrl: PR, platform: 'github' });
    seedDb.setEmbedding(twinId, vectorFor('c5-n960'), EMBEDDING_MODEL_ID);
    seedDb.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform, source_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run('holder', 'Old title', 'holder body', PR, 'github', connectorItemKey('github', PR)!);
    raw.close();

    const client = createLocalGatewayClient(dbPath);
    const { snapshots } = await client.ingestBatch([
      { platform: 'slack', source_url: 'https://new.test/b', title: 'c5-n961', raw_text: 'c5-n961 loads the matrix first' },
      { platform: 'github', source_url: PR, title: 'New title', raw_text: 'c5-n960 the same PR after the edit' },
    ], { classify: false, keyed: true });
    client.close();

    const ids = snapshots[1]!.analysis.relatedDecisions.map((r: { id: string }) => r.id);
    expect(snapshots[1]!.id).toBe('holder');
    expect(ids).toContain(snapshots[0]!.id);   // control: the cluster mate IS linked
    expect(ids).not.toContain(twinId);
    const check = createLocalDb(dbPath);
    expect(check.getDecisionById(twinId)).toBeNull();   // control: the fold really deleted it
    check.close();
  });
});
