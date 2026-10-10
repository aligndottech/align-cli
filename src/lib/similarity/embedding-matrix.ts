/**
 * An in-memory copy of every stored embedding, held as ONE contiguous Float32Array, with an
 * exhaustive top-K scan over it (plan LB, decision 26).
 *
 * Why it exists: ingest ranked each new item against the whole graph by re-reading every
 * stored vector out of SQLite, decoding it, and cosine-scoring it, once per item. Measured
 * (profile at 5,000 rows): read and decode 5.7 ms, cosine 1.9 ms, sort 0.4 ms per item, and
 * the read grows with the graph, so a batch was quadratic. Loading once per run and appending
 * as items land removes the read; scoring against precomputed norms removes two thirds of the
 * arithmetic. The scan stays EXHAUSTIVE - narrowing candidates would drop the cross-tool links
 * the product exists for - so results must equal the old scan exactly. They do: the dot
 * product accumulates in the same order as cosineSimilarity and divides by the same
 * sqrt(normQuery) * sqrt(normRow), so every score is bit-identical, not merely close.
 *
 * Pure: no database, no model. The caller decides which rows go in.
 */

export interface Scored { decisionId: string; score: number }

/** The one writer of the "different model" error, shared with cosineSimilarity. */
export function embeddingLengthMismatch(a: number, b: number): Error {
  return new Error(
    `Embedding length mismatch: ${a} vs ${b}. The local graph holds a vector ` +
    'from a different model - run `align local reset` and re-import to rebuild it.',
  );
}

const INITIAL_ROWS = 256;

export class EmbeddingMatrix {
  private dim = -1;
  private data = new Float32Array(0);
  private sqrtNorms = new Float64Array(0);
  private ids: string[] = [];
  private index = new Map<string, number>();

  static fromRows(rows: Array<{ decisionId: string; embedding: Float32Array }>): EmbeddingMatrix {
    const m = new EmbeddingMatrix();
    for (const r of rows) m.add(r.decisionId, r.embedding);
    return m;
  }

  get size(): number { return this.ids.length; }

  /** Adds a row, or replaces the vector of an id already held (setEmbedding is INSERT OR
   *  REPLACE, so the matrix must never hold two vectors for one decision). */
  add(decisionId: string, embedding: Float32Array): void {
    if (this.dim === -1) this.dim = embedding.length;
    else if (embedding.length !== this.dim) throw embeddingLengthMismatch(embedding.length, this.dim);
    let row = this.index.get(decisionId);
    if (row === undefined) {
      row = this.ids.length;
      if ((row + 1) * this.dim > this.data.length) this.grow(Math.max(INITIAL_ROWS, row * 2));
      this.ids.push(decisionId);
      this.index.set(decisionId, row);
    }
    this.data.set(embedding, row * this.dim);
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += embedding[i]! * embedding[i]!;
    this.sqrtNorms[row] = Math.sqrt(norm);
  }

  /** The `k` best rows by cosine, best first; equal scores order by id in code-unit order.
   *  Rows scoring below `threshold` are dropped (default: none are; findSimilar passed 0). */
  topK(query: Float32Array, k: number, opts: { excludeId?: string; threshold?: number } = {}): Scored[] {
    const n = this.ids.length;
    if (n === 0 || k <= 0) return [];
    if (query.length !== this.dim) throw embeddingLengthMismatch(query.length, this.dim);
    const threshold = opts.threshold ?? -Infinity;
    const skip = opts.excludeId === undefined ? -1 : (this.index.get(opts.excludeId) ?? -1);
    let normQ = 0;
    for (let i = 0; i < this.dim; i++) normQ += query[i]! * query[i]!;
    const sqrtQ = Math.sqrt(normQ);

    const best: Scored[] = [];
    const dim = this.dim, data = this.data;
    for (let r = 0; r < n; r++) {
      if (r === skip) continue;
      const base = r * dim;
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += query[i]! * data[base + i]!;
      const denom = sqrtQ * this.sqrtNorms[r]!;
      const score = denom === 0 ? 0 : dot / denom;
      if (!(score >= threshold)) continue;
      if (best.length === k && !this.outranks(score, this.ids[r]!, best[k - 1]!)) continue;
      // Insertion into a list of at most k: k is 10 in ingest, so this beats any heap.
      let pos = best.length === k ? k - 1 : best.length;
      while (pos > 0 && this.outranks(score, this.ids[r]!, best[pos - 1]!)) {
        if (pos < k) best[pos] = best[pos - 1]!;
        pos--;
      }
      best[pos] = { decisionId: this.ids[r]!, score };
    }
    return best;
  }

  private outranks(score: number, id: string, other: Scored): boolean {
    return score > other.score || (score === other.score && id < other.decisionId);
  }

  private grow(rows: number): void {
    const data = new Float32Array(rows * this.dim);
    data.set(this.data);
    this.data = data;
    const norms = new Float64Array(rows);
    norms.set(this.sqrtNorms);
    this.sqrtNorms = norms;
  }
}
