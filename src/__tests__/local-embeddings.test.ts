import { describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => {
  const mockPipeline = vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue([{ data: new Float32Array(384).fill(0.1) }])
  );
  return { pipeline: mockPipeline };
});

import { cosineSimilarity, getEmbedding } from '../lib/local-embeddings.js';

describe('getEmbedding', () => {
  it('returns a 384-dim Float32Array', async () => {
    const result = await getEmbedding('Use Postgres for production');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  /**
   * Mismatched lengths used to produce NaN, and NaN is the worst possible answer here: the
   * loop indexes `b[i]` over `a.length`, so a shorter `b` gives undefined -> NaN, and
   * findSimilar's `score >= threshold` is false for NaN, so the row is silently dropped as
   * IRRELEVANT. A graph holding one vector from another model would make decisions quietly
   * unfindable with nothing in the output to say so.
   */
  it('throws on mismatched lengths rather than returning NaN', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([1, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow(/length mismatch/i);
  });

  it('names both lengths and the remedy, since the fix is to rebuild the graph', () => {
    expect(() => cosineSimilarity(new Float32Array(384), new Float32Array(768)))
      .toThrow(/384.*768[\s\S]*align local reset/i);
  });

  // The boundary: the guard must not reject the shorter-but-equal case, which is legitimate
  // and is what every other test in this block uses.
  it('accepts equal lengths of any size', () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([1, 1]))).toBeCloseTo(1.0);
  });
});
