/**
 * Shane Wall's 0.77.1 rerun (#582): later_on_topic always filled three slots, results were not in
 * similarity order, and a merge commit took a slot beside the commit it carries.
 *
 * Test List:
 * 1. a later decision that is mutually near the hit is listed (on-topic still appears)
 * 2. a later decision at the SAME score to the hit, but with closer neighbours of its own, is not
 * 3. the newest decision gets no later_on_topic at all
 * 5. a merge row that only carries another result's change is dropped; the commit stays
 * 6. pair: a merge-titled row that is not another result stays
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(),
  cosineSimilarity: vi.fn(),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { cosineSimilarity, getEmbedding } from '../lib/local-embeddings.js';

beforeEach(() => { vi.stubEnv('ALIGN_DETECTOR', 'v0'); });
afterEach(() => { vi.unstubAllEnvs(); });

// Slot comes from "(sN)" in the title. Slot 9 vectors are queries.
const slotOf = (t: string) => Number(/\(s(\d+)\)/.exec(t)?.[1] ?? 0);
let DENSE: Record<number, number> = {};
let PAIR: Record<string, number> = {};
const key = (a: number, b: number) => [a, b].sort((x, y) => x - y).join('-');

const row = (slot: number, day: string, extra: { text?: string; title?: string; url?: string } = {}) => {
  const title = extra.title ?? `Tick rate decision number ${slot} (s${slot})`;
  return { title, raw_text: extra.text ?? title, created_at: `2026-10-${day}T10:00:00Z`, platform: 'git', source_url: extra.url ?? `https://github.com/acme/argus/commit/${slot}` };
};

describe('local search: later_on_topic, order and merge duplicates', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-later-order-${Date.now()}-${Math.random()}.db`);
    client = createLocalGatewayClient(dbPath);
    DENSE = {}; PAIR = {};
    const vec = (t: string) => { const v = new Float32Array(384).fill(0.1); v[0] = slotOf(t) || 9; return v; };
    vi.mocked(getEmbedding).mockImplementation(async (t: string) => vec(t));
    vi.mocked(cosineSimilarity).mockImplementation((q: Float32Array, s: Float32Array) => {
      if (q[0] === 9) return DENSE[s[0]] ?? 0;
      return q[0] === s[0] ? 1 : PAIR[key(q[0], s[0])] ?? 0;
    });
  });
  afterEach(() => { client.close(); if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); });

  type R = { title: string; summary: string; similarity: number; later_on_topic?: Array<{ title: string }> };
  const search = async () => (await client.searchDecisions('what is the tick rate', 10, undefined, { all: true })).results as unknown as R[];
  const tags = (xs: Array<{ title: string }> | undefined) => (xs ?? []).map(x => /\((s\d+)\)/.exec(x.title)?.[1]);

  // s1 = the hit (oldest). s2 = on topic, later. s3 = later, same score to s1, but s4-s8 are all closer to it.
  const cluster = async () => {
    DENSE = { 1: 0.7 };
    PAIR = { '1-2': 0.6, '1-3': 0.6, '3-4': 0.9, '3-5': 0.9, '3-6': 0.9, '3-7': 0.9, '3-8': 0.9 };
    await client.ingestBatch([row(1, '01'), row(2, '10'), row(3, '11'), row(4, '12'), row(5, '12'), row(6, '12'), row(7, '12'), row(8, '12')], { classify: false });
  };

  it('lists a later decision that is mutually near the hit', async () => {
    await cluster();
    const hit = (await search()).find(r => /\(s1\)/.test(r.title))!;
    expect(tags(hit.later_on_topic)).toContain('s2');
  });

  it('does not list a later decision at the same score whose own closest neighbours are other decisions', async () => {
    await cluster();
    const hit = (await search()).find(r => /\(s1\)/.test(r.title))!;
    expect(tags(hit.later_on_topic)).not.toContain('s3');
  });

  it('gives the newest decision no later_on_topic', async () => {
    DENSE = { 8: 0.7 };
    PAIR = { '1-8': 0.6, '2-8': 0.6, '3-8': 0.6 };
    await client.ingestBatch([row(1, '01'), row(2, '02'), row(3, '03'), row(8, '20')], { classify: false });
    const newest = (await search()).find(r => /\(s8\)/.test(r.title))!;
    expect(newest.later_on_topic).toBeUndefined();
  });


  it('drops a merge commit that only carries another result, and keeps the commit', async () => {
    DENSE = { 1: 0.7 };
    // The merge row repeats s1's title (a promoted merge takes the PR title) and keeps the merge line in its text.
    const merge = row(1, '02', { text: 'Tick rate decision number 1 (s1)\n\nMerge pull request #7 from acme/tick', url: 'https://github.com/acme/argus/commit/99' });
    await client.ingestBatch([row(1, '01'), merge], { classify: false });
    const results = await search();
    expect(results.filter(r => /\(s1\)/.test(r.title))).toHaveLength(1);
    expect(results.some(r => /Merge pull request/.test(r.summary))).toBe(false);
  });

  it('keeps a merge row whose title is not another result (pair)', async () => {
    DENSE = { 1: 0.7, 2: 0.68 };
    await client.ingestBatch([row(1, '01'), row(2, '02', { title: 'Merge the tick rate calibration branch (s2)', text: 'Merge the tick rate calibration branch (s2)\n\nMerge pull request #8 from acme/cal' })], { classify: false });
    const results = await search();
    expect(results.map(r => /\((s\d+)\)/.exec(r.title)?.[1]).sort()).toEqual(['s1', 's2']);
  });

  it('carries later_on_topic on checkAlignment relevant_decisions, by the same rule', async () => {
    await cluster();
    DENSE = { 1: 0.7 };
    const res = await client.checkAlignment('what is the tick rate', undefined, { depth: 'related' });
    const hit = (res.relevant_decisions as unknown as R[]).find(r => /\(s1\)/.test(r.title))!;
    expect(tags(hit.later_on_topic)).toEqual(['s2']);
  });
});
