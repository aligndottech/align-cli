type EmbeddingPipeline = (text: string, options: Record<string, unknown>) => Promise<Array<{ data: Float32Array }>>;
let _pipe: EmbeddingPipeline | null = null;

export async function getEmbedding(text: string): Promise<Float32Array> {
  if (!_pipe) {
    let mod: { pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown> };
    try {
      // @huggingface/transformers is an optionalDependency - its native deps (sharp,
      // onnxruntime) can fail to install on Alpine/ARM/behind a proxy. If it's
      // missing, point the user at cloud mode rather than a raw "Cannot find module".
      //
      // The specifier is a variable ON PURPOSE: a literal makes tsc resolve the
      // module at typecheck time, so `npm run typecheck` fails with TS2307 on any
      // machine where the OPTIONAL install was skipped - which npm does silently
      // (a CI run installed 398 packages where its sibling installed 438, and the
      // only trace was the red typecheck). An optional dep must be optional to
      // the typechecker too.
      const HF_TRANSFORMERS = '@huggingface/transformers';
      mod = (await import(HF_TRANSFORMERS)) as unknown as typeof mod;
    } catch (err) {
      throw new Error(
        'Local mode needs the on-device embedding model (@huggingface/transformers), which is not installed on this platform. ' +
        'Use cloud mode (`align login`), or reinstall on a supported platform (macOS, glibc Linux, or Windows x64/arm64). ' +
        `(${(err as Error).message})`,
      );
    }
    try {
      // First call downloads ~23MB from the Hugging Face Hub (huggingface.co), then caches.
      // dtype 'q8' is load-bearing, not a perf tweak: @xenova/transformers@2 loaded
      // quantized weights by default and v3+ default to fp32, which shifts pairwise
      // cosine by up to 2.3e-02 against vectors already persisted in a user's local
      // graph. Pinning q8 holds that to 6.6e-04. See local-embeddings-dtype.test.ts.
      // The size follows from that pin: q8 fetches onnx/model_quantized.onnx (22.0MiB) plus
      // the tokenizer, where fp32 would be 86.2MiB. This comment and the copy in setup.ts
      // and README.md said "~90MB" for both, quoting the file the pin exists to avoid.
      _pipe = (await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'q8',
      })) as unknown as EmbeddingPipeline;
    } catch (err) {
      throw new Error(
        'Could not load the local embedding model (~23MB, Xenova/all-MiniLM-L6-v2, from huggingface.co). ' +
        'Check your internet connection or proxy and try again. ' +
        `(${(err as Error).message})`,
      );
    }
  }
  const output = await _pipe(text, { pooling: 'mean', normalize: true });
  return output[0]!.data;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Loudly, because the silent version is worse than a crash: this loop indexes `b[i]` over
  // `a.length`, so a shorter `b` yields undefined -> NaN -> `NaN >= threshold` is false, and
  // findSimilar drops the row as IRRELEVANT. A vector written by a different model would make
  // decisions quietly unfindable with no error anywhere.
  if (a.length !== b.length) {
    throw new Error(
      `Embedding length mismatch: ${a.length} vs ${b.length}. The local graph holds a vector ` +
      'from a different model - run `align local reset` and re-import to rebuild it.',
    );
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
