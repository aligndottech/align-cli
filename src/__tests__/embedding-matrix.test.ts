import { describe, expect, it } from 'vitest';
import { EmbeddingMatrix, MATRIX_MAX_ROWS } from '../lib/similarity/embedding-matrix.js';
import { cosineSimilarity } from '../lib/local-embeddings.js';

// Deterministic, NOT unit-length on purpose: the matrix must score exactly like the legacy
// cosineSimilarity, which divides by the norms, so a fixture that is already normalised
// could not tell a dot product from a cosine.
let seed = 12345;
const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32 - 0.5; };
const vec = (dim = 16, scale = 1) => Float32Array.from({ length: dim }, () => rand() * scale);
const rows = (n: number, dim = 16) => Array.from({ length: n }, (_, i) => ({ decisionId: `d${String(i).padStart(3, '0')}`, embedding: vec(dim, 1 + (i % 5)) }));

describe('EmbeddingMatrix.topK', () => {
  it('returns the k best rows, best first', () => {
    const data = rows(40);
    const q = vec();
    const got = EmbeddingMatrix.fromRows(data).topK(q, 5);
    const want = data.map(r => ({ decisionId: r.decisionId, score: cosineSimilarity(q, r.embedding) }))
      .sort((a, b) => b.score - a.score).slice(0, 5);
    expect(got.map(g => g.decisionId)).toEqual(want.map(w => w.decisionId));
  });

  it('scores bit-for-bit like cosineSimilarity, whatever the vector length', () => {
    for (const dim of [3, 384]) {
      const data = rows(25, dim);
      const q = vec(dim, 7);
      const got = EmbeddingMatrix.fromRows(data).topK(q, 25);
      const byId = new Map(data.map(r => [r.decisionId, r.embedding]));
      expect(got).toHaveLength(25);
      for (const g of got) expect(g.score).toBe(cosineSimilarity(q, byId.get(g.decisionId)!));
    }
  });

  it('breaks equal scores by id in code-unit order, not locale order', () => {
    const same = Float32Array.from([1, 2, 3]);
    const m = EmbeddingMatrix.fromRows([
      { decisionId: 'b', embedding: same }, { decisionId: 'a', embedding: same }, { decisionId: 'B', embedding: same },
    ]);
    // 'B' (0x42) sorts before 'a' (0x61) by code unit; localeCompare would put 'a' first.
    expect(m.topK(same, 3).map(r => r.decisionId)).toEqual(['B', 'a', 'b']);
    expect(m.topK(same, 2).map(r => r.decisionId)).toEqual(['B', 'a']);
  });

  it('leaves out the excluded id and still returns k others', () => {
    const data = rows(10);
    const m = EmbeddingMatrix.fromRows(data);
    const q = data[3]!.embedding;
    expect(m.topK(q, 1)[0]!.decisionId).toBe('d003');
    const without = m.topK(q, 3, { excludeId: 'd003' });
    expect(without).toHaveLength(3);
    expect(without.map(r => r.decisionId)).not.toContain('d003');
  });

  it('keeps a row scoring exactly the threshold and drops one below it', () => {
    const q = Float32Array.from([1, 0]);
    const m = EmbeddingMatrix.fromRows([
      { decisionId: 'hit', embedding: Float32Array.from([1, 0]) },
      { decisionId: 'edge', embedding: Float32Array.from([0, 1]) },
      { decisionId: 'miss', embedding: Float32Array.from([-1, 0]) },
    ]);
    expect(m.topK(q, 5, { threshold: 0 }).map(r => r.decisionId)).toEqual(['hit', 'edge']);
    expect(m.topK(q, 5, { threshold: 0.5 }).map(r => r.decisionId)).toEqual(['hit']);
  });

  it('returns fewer than k when the matrix is smaller, and nothing when empty', () => {
    expect(EmbeddingMatrix.fromRows(rows(2)).topK(vec(), 10)).toHaveLength(2);
    expect(EmbeddingMatrix.fromRows([]).topK(vec(), 10)).toEqual([]);
  });

  it('scores a zero vector 0, like cosineSimilarity, instead of NaN', () => {
    const m = EmbeddingMatrix.fromRows([{ decisionId: 'z', embedding: new Float32Array(4) }]);
    expect(m.topK(Float32Array.from([1, 1, 1, 1]), 1)).toEqual([{ decisionId: 'z', score: 0 }]);
  });
});

describe('EmbeddingMatrix NaN scores', () => {
  // A stored vector holding NaN scores NaN. The old scan dropped it (`NaN >= threshold` is
  // false); `score < threshold` would keep it, because that is false too. Pinned both ways.
  it('drops a NaN-score row whether or not a threshold is given', () => {
    const m = EmbeddingMatrix.fromRows([
      { decisionId: 'nan', embedding: Float32Array.from([NaN, 1]) },
      { decisionId: 'ok', embedding: Float32Array.from([1, 1]) },
    ]);
    const q = Float32Array.from([1, 1]);
    expect(m.topK(q, 5).map(r => r.decisionId)).toEqual(['ok']);
    expect(m.topK(q, 5, { threshold: 0 }).map(r => r.decisionId)).toEqual(['ok']);
    expect(m.topK(q, 5, { threshold: -Infinity }).map(r => r.decisionId)).toEqual(['ok']);
  });
});

describe('EmbeddingMatrix.add', () => {
  it('makes a row found by the next query, with no reload', () => {
    const m = EmbeddingMatrix.fromRows(rows(5));
    const fresh = vec(16, 3);
    m.add('new', fresh);
    expect(m.size).toBe(6);
    expect(m.topK(fresh, 1)[0]).toEqual({ decisionId: 'new', score: cosineSimilarity(fresh, fresh) });
  });

  it('replaces the vector of an id already held, as setEmbedding does, instead of holding two', () => {
    const m = EmbeddingMatrix.fromRows(rows(5));
    const q = vec(16, 2);
    m.add('d002', q);
    expect(m.size).toBe(5);
    expect(m.topK(q, 5).filter(r => r.decisionId === 'd002')).toHaveLength(1);
    expect(m.topK(q, 1)[0]!.decisionId).toBe('d002');
  });

  it('grows past its first allocation without losing rows', () => {
    const m = EmbeddingMatrix.fromRows([]);
    const all = rows(300, 8);
    for (const r of all) m.add(r.decisionId, r.embedding);
    expect(m.size).toBe(300);
    const q = all[257]!.embedding;
    expect(m.topK(q, 1)[0]!.decisionId).toBe('d257');
  });
});

describe('EmbeddingMatrix length mismatch', () => {
  it('fails loudly like cosineSimilarity, naming the way out', () => {
    const m = EmbeddingMatrix.fromRows(rows(2, 16));
    expect(() => m.topK(vec(8), 1)).toThrow(/Embedding length mismatch: 8 vs 16.*align local reset/);
    expect(() => m.add('x', vec(8))).toThrow(/Embedding length mismatch: 8 vs 16/);
    expect(() => EmbeddingMatrix.fromRows([
      { decisionId: 'a', embedding: vec(4) }, { decisionId: 'b', embedding: vec(5) },
    ])).toThrow(/Embedding length mismatch/);
  });
});

describe('MATRIX_MAX_ROWS', () => {
  it('is the documented 150,000-row guard', () => {
    expect(MATRIX_MAX_ROWS).toBe(150_000);
  });
});
