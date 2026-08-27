import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));

vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { cosineSimilarity, getEmbedding } from '../lib/local-embeddings.js';
import { contentWordQuery } from '../lib/search-query.js';

// Distinct vectors per query text, so cosineSimilarity can tell which query it is
// scoring. Without this both attempts embed identically and the test cannot
// distinguish a real fallback from the raw query happening to match.
const RAW = 1;
const REDUCED = 2;
function vectorFor(text: string): Float32Array {
  const v = new Float32Array(384).fill(0.1);
  v[0] = text.includes('why do we') || text.includes('how does our') ? RAW : REDUCED;
  return v;
}

describe('local search: content-word fallback for natural-language questions', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-sqf-${Date.now()}-${Math.random()}.db`);
    client = createLocalGatewayClient(dbPath);
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(384).fill(0.1));
    vi.mocked(cosineSimilarity).mockReturnValue(0.0);
  });

  afterEach(() => {
    client.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('returns the decision when the question form misses but its content words hit', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use postgres for the store', 'cli');

    // Raw question scores below SEARCH_THRESHOLD (0.25); content words score above it.
    vi.mocked(getEmbedding).mockImplementation(async (t: string) => vectorFor(t));
    vi.mocked(cosineSimilarity).mockImplementation((a: Float32Array) => (a[0] === RAW ? 0.10 : 0.75));

    const result = await client.searchDecisions('why do we use postgres', 5);
    expect(result.results.length).toBe(1);
    expect(result.results[0].title).toContain('postgres');
  });

  it('does not embed a second time when the raw query already matched', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use postgres for the store', 'cli');
    vi.mocked(getEmbedding).mockClear();

    const result = await client.searchDecisions('why do we use postgres', 5);
    expect(result.results.length).toBeGreaterThan(0);
    // Cost guard: the common path must stay one embedding per search.
    expect(vi.mocked(getEmbedding)).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the query is only question words', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use postgres for the store', 'cli');
    vi.mocked(getEmbedding).mockClear();
    vi.mocked(cosineSimilarity).mockReturnValue(0.0); // nothing clears the floor

    const result = await client.searchDecisions('why do we', 5);
    expect(result.results).toEqual([]);
    // Stripping would leave an empty string, so there is nothing to fall back to.
    expect(vi.mocked(getEmbedding)).toHaveBeenCalledTimes(1);
  });

  describe('contentWordQuery', () => {
    it('strips question scaffolding and keeps the subject', () => {
      expect(contentWordQuery('why do we use postgres')).toBe('use postgres');
      expect(contentWordQuery('how does our auth work')).toBe('auth work');
    });

    it('returns null when there is nothing to strip', () => {
      expect(contentWordQuery('postgres')).toBeNull();
      expect(contentWordQuery('auth token rotation')).toBeNull();
    });

    it('returns null when only scaffolding remains', () => {
      expect(contentWordQuery('why do we')).toBeNull();
      expect(contentWordQuery('what is it')).toBeNull();
    });
  });
});
