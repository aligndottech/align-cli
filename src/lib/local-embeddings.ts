type EmbeddingPipeline = (text: string, options: Record<string, unknown>) => Promise<Array<{ data: Float32Array }>>;
let _pipe: EmbeddingPipeline | null = null;

export async function getEmbedding(text: string): Promise<Float32Array> {
  if (!_pipe) {
    let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
    try {
      // @xenova/transformers is an optionalDependency - its native deps (sharp,
      // onnxruntime) can fail to install on Alpine/ARM/behind a proxy. If it's
      // missing, point the user at cloud mode rather than a raw "Cannot find module".
      mod = (await import('@xenova/transformers')) as unknown as typeof mod;
    } catch (err) {
      throw new Error(
        'Local mode needs the on-device embedding model (@xenova/transformers), which is not installed on this platform. ' +
        'Use cloud mode (`align login`), or reinstall on a supported platform (macOS, glibc Linux, or Windows x64/arm64). ' +
        `(${(err as Error).message})`,
      );
    }
    try {
      // First call downloads the ~90MB model from the Hugging Face Hub.
      _pipe = (await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')) as unknown as EmbeddingPipeline;
    } catch (err) {
      throw new Error(
        'Could not load the local embedding model (~90MB, Xenova/all-MiniLM-L6-v2). ' +
        'Check your internet connection or proxy and try again. ' +
        `(${(err as Error).message})`,
      );
    }
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
