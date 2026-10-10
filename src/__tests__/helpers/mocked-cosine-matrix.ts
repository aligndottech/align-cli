/**
 * A drop-in for EmbeddingMatrix that scores through `cosineSimilarity` from local-embeddings.
 *
 * Several suites drive link ranking by mocking `cosineSimilarity` (mockReturnValue(0.8),
 * mockImplementation over a score list) on vectors that are all the same. The real matrix
 * scores with its own prepared-norm dot product, so those mocks would no longer reach ingest.
 * Those suites test what ingest DOES with scores (thresholds, top-K, typing), not how scores
 * are computed, so they swap this in and keep their meaning. It ranks exactly as the old
 * per-item scan did: one cosineSimilarity call per held row, in load order.
 *
 * The real matrix is pinned separately: embedding-matrix.test.ts (bit-equal to the real
 * cosineSimilarity) and local-ingest-similarity-parity.test.ts (end to end).
 *
 * Use in a test file:
 *   vi.mock('../lib/similarity/embedding-matrix.js', async () =>
 *     (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
 */
import { vi } from 'vitest';
import type * as RealMatrix from '../../lib/similarity/embedding-matrix.js';

export async function mockedCosineMatrixModule(): Promise<typeof RealMatrix> {
  const real = await vi.importActual<typeof RealMatrix>('../../lib/similarity/embedding-matrix.js');
  const { cosineSimilarity } = await import('../../lib/local-embeddings.js');

  class MockedCosineMatrix {
    private rows: Array<{ decisionId: string; embedding: Float32Array }> = [];
    static fromRows(rows: Array<{ decisionId: string; embedding: Float32Array }>): MockedCosineMatrix {
      const m = new MockedCosineMatrix();
      for (const r of rows) m.add(r.decisionId, r.embedding);
      return m;
    }
    get size(): number { return this.rows.length; }
    add(decisionId: string, embedding: Float32Array): void {
      const i = this.rows.findIndex((r) => r.decisionId === decisionId);
      if (i === -1) this.rows.push({ decisionId, embedding });
      else this.rows[i] = { decisionId, embedding };
    }
    topK(query: Float32Array, k: number, opts: { excludeId?: string; threshold?: number } = {}) {
      const threshold = opts.threshold ?? -Infinity;
      return this.rows
        .filter((r) => r.decisionId !== opts.excludeId)
        .map((r) => ({ decisionId: r.decisionId, score: cosineSimilarity(query, r.embedding) }))
        .filter((e) => e.score >= threshold)
        .sort((a, b) => b.score - a.score || (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0))
        .slice(0, k);
    }
  }
  return { ...real, EmbeddingMatrix: MockedCosineMatrix as unknown as typeof RealMatrix.EmbeddingMatrix };
}
