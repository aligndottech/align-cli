import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Test list (Given / When / Then, two examples per rule)
 *
 * Which embedding stands in: a hand-built vector fixture, not the real model. The repo's other suites
 * mock getEmbedding to a constant, which cannot say whether the line or the code is nearer a decision,
 * so it cannot be made faithful here. Each text maps to a unit vector chosen so the decision sits near
 * the line and far from the code, which is the measured shape. Cosine is the real dot product. The real
 * model run over the stored graphs is a measurement, reported in the commit message, not a test.
 *
 * Second query through the hook's retrieval
 *  1. Given an ADR near the line and far from the code, when the hook asks with the line, then it is retrieved.
 *  2. Given a second ADR in the same position, then it is retrieved too, and the unrelated one is not.
 *  3. Given the same edit asked without a line (before this change), then neither is retrieved.
 * Max over both queries
 *  4. Given a decision the code matches strongly and the line does not, then it keeps the code score.
 *  5. Given a decision both match, then similarity is the larger of the two.
 * Floor
 *  6. Given a line score just under the floor, then nothing is retrieved.
 *  7. Given a line score exactly at the floor, then it is retrieved.
 * Non-source edits
 *  8. Given a README edit, then the hook builds no line and retrieves nothing.
 *  9. Given a lockfile edit, then the same.
 * Call site
 * 10. Given an edit hook payload for a source file, then checkAlignment receives the line for that path and text.
 * 11. Given a README payload, then checkAlignment receives no line.
 */

const DIM = 384;
const unit = (parts: Record<number, number>): Float32Array => {
  const v = new Float32Array(DIM);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

const vectors = new Map<string, Float32Array>();
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (text: string) => vectors.get(text) ?? new Float32Array(DIM)),
  cosineSimilarity: (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; },
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { createLocalDb } from '../lib/local-db.js';
import { intentLine } from '../lib/edit-intent-line.js';
import { EMBEDDING_MODEL_ID } from '../lib/local-embeddings.js';

const CODE = 'pub async fn suggest_fix() { client.post("https://api.openai.com/v1/chat/completions") }';
const PATH = 'crates/gate/src/llm_client.rs';

describe('the edit hook retrieves with a second query built from the edit', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  const ids: Record<string, string> = {};

  const seed = (name: string, embedding: Float32Array) => {
    const db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: name, summary: `${name} summary`, sourceUrl: `https://example.test/${name}`, platform: 'manual' });
    db.setEmbedding(id, embedding, EMBEDDING_MODEL_ID);
    ids[name] = id;
    db.close();
  };
  const hook = (filePath: string, text: string, withLine = true) =>
    client.checkAlignment(text, undefined, { depth: 'related', ...(withLine && intentLine({ filePath, text }) ? { intent: intentLine({ filePath, text }) } : {}) });
  const retrieved = (r: Awaited<ReturnType<typeof hook>>) => r.relevant_decisions.map((d) => d.id);

  beforeEach(() => {
    vectors.clear();
    dbPath = path.join(os.tmpdir(), `align-intent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    vectors.set(CODE, unit({ 0: 1 }));
    vectors.set(intentLine({ filePath: PATH, text: CODE }), unit({ 1: 1 }));
    // near the line (cos ~0.98), far from the code (cos ~0.2, under the 0.30 floor)
    seed('adr-no-llm-in-gate', unit({ 0: 0.2, 1: 0.98 }));
    seed('adr-second', unit({ 0: 0.15, 1: 0.99 }));
    seed('unrelated', unit({ 2: 1 }));
    seed('code-near', unit({ 0: 0.9, 2: 0.4 }));
    client = createLocalGatewayClient(dbPath);
  });
  afterEach(() => {
    client.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('retrieves an ADR near the line and far from the code', async () => {
    expect(retrieved(await hook(PATH, CODE))).toContain(ids['adr-no-llm-in-gate']);
  });

  it('retrieves a second such ADR and leaves the unrelated one out', async () => {
    const got = retrieved(await hook(PATH, CODE));
    expect(got).toContain(ids['adr-second']);
    expect(got).not.toContain(ids['unrelated']);
  });

  it('retrieves neither when the line is not asked', async () => {
    const got = retrieved(await hook(PATH, CODE, false));
    expect(got).not.toContain(ids['adr-no-llm-in-gate']);
    expect(got).not.toContain(ids['adr-second']);
  });

  it('keeps the code score for a decision only the code matches', async () => {
    const hit = (await hook(PATH, CODE)).relevant_decisions.find((d) => d.id === ids['code-near'])!;
    expect(hit.similarity).toBeCloseTo(0.9 / Math.hypot(0.9, 0.4), 3);
  });

  it('reports the larger of the two scores for a decision both match', async () => {
    const hit = (await hook(PATH, CODE)).relevant_decisions.find((d) => d.id === ids['adr-no-llm-in-gate'])!;
    expect(hit.similarity).toBeCloseTo(0.98 / Math.hypot(0.2, 0.98), 3);
    expect(hit.similarity).toBeGreaterThan(0.9);
  });

  it('retrieves nothing when the line scores just under the floor', async () => {
    const lineText = intentLine({ filePath: PATH, text: CODE });
    vectors.set(lineText, unit({ 3: 1 }));
    seed('under', unit({ 3: 0.29, 4: Math.sqrt(1 - 0.29 ** 2) }));
    expect(retrieved(await hook(PATH, CODE))).not.toContain(ids['under']);
  });

  it('retrieves a decision whose line score sits exactly at the floor', async () => {
    const lineText = intentLine({ filePath: PATH, text: CODE });
    vectors.set(lineText, unit({ 3: 1 }));
    seed('at-floor', unit({ 3: 0.3, 4: Math.sqrt(1 - 0.3 ** 2) }));
    expect(retrieved(await hook(PATH, CODE))).toContain(ids['at-floor']);
  });

  it.each([['README.md', 'check your changes before merge'], ['package-lock.json', '"version": "7.6.3"']])('builds no line for %s and keeps the ADR out', async (file, text) => {
    // The first query still runs (it matches 'unrelated'); the second must not, so the ADR stays out.
    vectors.set(text, unit({ 2: 1 }));
    expect(intentLine({ filePath: file, text })).toBe('');
    const got = retrieved(await hook(file, text));
    expect(got).toContain(ids['unrelated']);
    expect(got).not.toContain(ids['adr-no-llm-in-gate']);
  });
});
