type EmbeddingPipeline = (text: string, options: Record<string, unknown>) => Promise<Array<{ data: Float32Array }>>;
let _pipe: EmbeddingPipeline | null = null;

export async function getEmbedding(text: string): Promise<Float32Array> {
  if (!_pipe) {
    const { pipeline } = await import('@xenova/transformers');
    _pipe = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')) as unknown as EmbeddingPipeline;
  }
  const output = await _pipe(text, { pooling: 'mean', normalize: true });
  return output[0]!.data;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
