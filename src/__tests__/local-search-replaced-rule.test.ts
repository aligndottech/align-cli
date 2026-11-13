/**
 * Found in a user's trial (local mode, no AI key): searching the local graph for a tick rate
 * returned the old, refuted rule first, with nothing marking it replaced.
 *
 * Test List:
 * 1. the dense order is kept (the old rule may still rank first), and the old hit now points at its
 *    correction. Reordering is deliberately NOT done: with no AI key nothing tells a correction from a
 *    same-topic note (test 5's "also" scores exactly like the fix), so promoting newer rows would put
 *    "log the tick rate on startup" above the rule. The marker is what tells the agent to read on.
 * 2. (was: the older hit carries no later_on_topic - the reproduced bug, RED before the wiring)
 * 3. the older hit names the newer same-topic decision in later_on_topic (decided_at as the date)
 * 4. the newer decision does not list the older one (only LATER decisions count)
 * 5. pair: two same-topic decisions that are not a correction do NOT mark each other
 * 6. pair: an unrelated later decision is not listed
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

// Slot 1 = old rule, 2 = correction, 3 = noise, 4 = a second same-topic note that corrects nothing.
// Query-to-row scores are chosen: the old rule repeats the question's words, so it scores highest.
const DENSE: Record<number, number> = { 1: 0.72, 2: 0.6, 3: 0.12, 4: 0.58, 5: 0.4 };
// Row-to-row similarity, used when a row is the "query" (later_on_topic looks for its neighbours).
const PAIR: Record<string, number> = { '1-2': 0.7, '1-4': 0.7, '1-3': 0.1, '2-3': 0.1, '2-4': 0.7, '3-4': 0.1 };
const slotOf = (t: string) => (/\(old\)/.test(t) ? 1 : /\(fix\)/.test(t) ? 2 : /\(noise\)/.test(t) ? 3 : /\(also\)/.test(t) ? 4 : /\(pre\)/.test(t) ? 5 : 9);

const OLD = { title: 'Frametime is 0.1s, a 10 Hz tick rate, measured not assumed (old)', raw_text: 'Frametime is 0.1s, a 10 Hz tick rate, measured not assumed (old)', created_at: '2026-09-01T10:00:00Z' };
const FIX = { title: 'Frametime correction: the engine frame counter says 19 Hz, about 0.05s (fix)', raw_text: 'Frametime correction: the engine frame counter says 19 Hz, about 0.05s (fix)', created_at: '2026-10-15T10:00:00Z' };
const NOISE = { title: 'Add a pause menu to the HUD (noise)', raw_text: 'Add a pause menu to the HUD (noise)', created_at: '2026-10-20T10:00:00Z' };
// Older than the rule and the weakest match, so search order and date order disagree about it.
const PRE = { title: 'Tick rate starts at 5 Hz for the prototype (pre)', raw_text: 'Tick rate starts at 5 Hz for the prototype (pre)', created_at: '2026-08-01T10:00:00Z' };
const ALSO = { title: 'Log the tick rate on startup (also)', raw_text: 'Log the tick rate on startup (also)', created_at: '2026-10-16T10:00:00Z' };

describe('local search: an older refuted rule and its correction', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `align-replaced-${Date.now()}-${Math.random()}.db`);
    client = createLocalGatewayClient(dbPath);
    const vec = (t: string) => { const v = new Float32Array(384).fill(0.1); v[0] = slotOf(t); return v; };
    vi.mocked(getEmbedding).mockImplementation(async (t: string) => vec(t));
    vi.mocked(cosineSimilarity).mockImplementation((q: Float32Array, stored: Float32Array) => {
      if (q[0] === 9) return DENSE[stored[0]] ?? 0;
      return q[0] === stored[0] ? 1 : PAIR[[q[0], stored[0]].sort().join('-')] ?? 0;
    });
  });
  afterEach(() => { client.close(); if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); });

  const seed = (...items: Array<typeof OLD>) => client.ingestBatch(items.map(i => ({ ...i, platform: 'git', source_url: `https://github.com/acme/argus/commit/${slotOf(i.title)}` })), { classify: false });
  const byTag = (rows: Array<{ title: string }>) => rows.map(r => /\((\w+)\)$/.exec(r.title)?.[1]);

  it('keeps the dense order, and the first hit (the old rule) now names its correction', async () => {
    await seed(OLD, FIX, NOISE);
    const { results } = await client.searchDecisions('what is the tick rate', 5, undefined, { all: true });
    expect(byTag(results)).toEqual(['old', 'fix']);
    const first = results[0] as unknown as { later_on_topic?: Array<{ id: string }> };
    expect(first.later_on_topic?.[0]?.id).toBe(results[1]!.id);
  });

  it('lists the newer same-topic decision on the older hit, dated by decided_at', async () => {
    await seed(OLD, FIX, NOISE);
    const { results } = await client.searchDecisions('what is the tick rate', 5, undefined, { all: true });
    const old = results.find(r => /\(old\)/.test(r.title)) as unknown as { later_on_topic?: Array<Record<string, unknown>> };
    expect(old.later_on_topic?.map(e => /\((\w+)\)$/.exec(String(e['title']))?.[1])).toEqual(['fix']);
    expect(old.later_on_topic![0]).toMatchObject({ id: expect.any(String), date_basis: 'decided', similarity: 0.7 });
  });

  it('does not list the older decision on the newer hit', async () => {
    await seed(OLD, FIX, NOISE);
    const { results } = await client.searchDecisions('what is the tick rate', 5, undefined, { all: true });
    const fix = results.find(r => /\(fix\)/.test(r.title)) as unknown as Record<string, unknown>;
    expect(fix['later_on_topic']).toBeUndefined();
  });

  it('PAIR: a later same-topic note that is merely similar is listed with its similarity, and an unrelated later one is not', async () => {
    await seed(OLD, NOISE, ALSO);
    const { results } = await client.searchDecisions('what is the tick rate', 5, undefined, { all: true });
    const old = results.find(r => /\(old\)/.test(r.title)) as unknown as { later_on_topic?: Array<Record<string, unknown>> };
    expect(old.later_on_topic?.map(e => /\((\w+)\)$/.exec(String(e['title']))?.[1])).toEqual(['also']);
  });

  it('serves the topic timeline locally, oldest first by decided_at, not in search order', async () => {
    await seed(OLD, FIX, NOISE, PRE);
    const t = await client.getTopicTimeline('what is the tick rate', 50, undefined, { all: true });
    expect(byTag(t.decisions ?? [])).toEqual(['pre', 'old', 'fix']);
    expect(t.decisions?.[0]).toMatchObject({ decided_at: expect.stringContaining('2026-08-01'), date_basis: 'decided' });
    expect(t).toMatchObject({ topic: 'what is the tick rate', count: 3 });
  });
});
