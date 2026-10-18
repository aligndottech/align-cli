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

// Each stored decision gets a vector whose first slot names it, so the mocked cosine can give
// every one a chosen DENSE score. The two scores differ on purpose (0.666 vs 0.523).
const SLOT: Record<string, number> = { mention: 1, removal: 2 };
const DENSE: Record<number, number> = { 1: 0.666, 2: 0.523 };
const MENTION_TITLE = 'docs: update README for align why, align setup, and align mcp --setup (mention)';
const REMOVAL_TITLE = 'feat(setup): offer saved tokens; remove align setup (removal)';

describe('local search: title rerank over the dense candidates (ALI-1775)', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `align-rerank-${Date.now()}-${Math.random()}.db`);
    client = createLocalGatewayClient(dbPath);
    vi.mocked(getEmbedding).mockImplementation(async (t: string) => {
      const v = new Float32Array(384).fill(0.1);
      v[0] = t.includes('(mention)') ? SLOT.mention : t.includes('(removal)') ? SLOT.removal : 9;
      return v;
    });
    vi.mocked(cosineSimilarity).mockImplementation((_q: Float32Array, stored: Float32Array) => DENSE[stored[0]] ?? 0.0);
    await client.captureDecision(MENTION_TITLE, 'cli');
    await client.captureDecision(REMOVAL_TITLE, 'cli');
  });

  afterEach(() => {
    client.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('puts the decision whose title names the subject and the action first, and reports dense similarity', async () => {
    const { results } = await client.searchDecisions('why was align setup removed', 5);
    expect(results.map(r => /\((\w+)\)$/.exec(r.title)?.[1])).toEqual(['removal', 'mention']);
    expect(results.map(r => r.similarity)).toEqual([0.523, 0.666]);
  });

  it('retrieves wider than the limit, so a lower-ranked row can win the single slot', async () => {
    const { results } = await client.searchDecisions('why was align setup removed', 1);
    expect(results.map(r => /\((\w+)\)$/.exec(r.title)?.[1])).toEqual(['removal']);
  });
});
