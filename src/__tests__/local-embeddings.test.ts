import { describe, expect, it, vi } from 'vitest';

vi.mock('@xenova/transformers', () => {
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
});
