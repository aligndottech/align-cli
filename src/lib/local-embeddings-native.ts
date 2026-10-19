/**
 * The npm distribution's embedding backend (ALI-1781): the same model, the same weights and the
 * same arithmetic transformers.js ran, without transformers.js.
 *
 * transformers.js was only ever glue here - tokenize, run one ONNX graph, mean-pool, normalise -
 * and its dependency tree was the 779MB. This does those four steps directly over the downloaded
 * native runtime (embedding-runtime.ts) and `@huggingface/tokenizers`, the same tokenizer
 * transformers.js 4 uses. Vectors are held to cosine >= 0.9999 against transformers.js on a fixed
 * corpus by scripts/verify-embedding-parity.mjs.
 *
 * Three behaviours are copied from transformers.js ON PURPOSE, because stored vectors depend on
 * them and each looks like a bug to a reader:
 *  - Truncation is a plain `slice(0, 512)`. The trailing [SEP] is NOT restored, so a long text
 *    ends mid-sentence in token space. Restoring it is the "obviously correct" fix and moves
 *    cosine to 0.99 on long commit messages.
 *  - All three int64 inputs are fed, with token_type_ids all zero.
 *  - The ONNX graph runs at the default optimisation level ('all'). The q8 model's dynamic
 *    quantisation is sensitive to fusion: 'disabled' or 'basic' moves cosine by up to 6e-03.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { ensureModel, type EnsureOptions, ensureRuntime, loadOrt } from './embedding-runtime.js';
import { inHookContext } from './hook-context.js';

const MAX_TOKENS = 512;
const DIMS = 384;

export type EmbeddingPipeline = (text: string, options: Record<string, unknown>) => Promise<Array<{ data: Float32Array }>>;

export interface SessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | ArrayLike<number> }>>;
}

/** Pure pipeline body, separated so the tokenizing, truncation and pooling are testable without
 *  a native runtime. */
export function buildPipeline(
  tokenizer: Pick<Tokenizer, 'encode'>,
  session: SessionLike,
  makeInt64: (data: BigInt64Array, dims: number[]) => unknown,
): EmbeddingPipeline {
  return async (text) => {
    const enc = tokenizer.encode(text);
    const ids = enc.ids.slice(0, MAX_TOKENS);
    const mask = enc.attention_mask.slice(0, MAX_TOKENS);
    const n = ids.length;
    const dims = [1, n];
    const feeds: Record<string, unknown> = {
      input_ids: makeInt64(BigInt64Array.from(ids, BigInt), dims),
      attention_mask: makeInt64(BigInt64Array.from(mask, BigInt), dims),
      token_type_ids: makeInt64(new BigInt64Array(n), dims),
    };
    const result = await session.run(feeds);
    const hidden = result[session.outputNames[0]!]!.data;
    const pooled = new Float32Array(DIMS);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      count++;
      for (let j = 0; j < DIMS; j++) pooled[j]! += hidden[i * DIMS + j]!;
    }
    if (count === 0) throw new Error('tokenizer produced no attended tokens');
    let norm = 0;
    for (let j = 0; j < DIMS; j++) { pooled[j] = pooled[j]! / count; norm += pooled[j]! * pooled[j]!; }
    norm = Math.sqrt(norm);
    for (let j = 0; j < DIMS; j++) pooled[j] = pooled[j]! / norm;
    return [{ data: pooled }];
  };
}

export async function createNativeEmbeddingPipeline(opts: Partial<EnsureOptions> = {}): Promise<EmbeddingPipeline> {
  const ensure: EnsureOptions = {
    // A hook runs on every edit and must never wait on a 20MB download (embedding-runtime.ts).
    allowDownload: !inHookContext(),
    notice: (m) => process.stderr.write(`${m}\n`),
    ...opts,
  };
  const [runtime, model] = [await ensureRuntime(ensure), await ensureModel(ensure)];
  const ort = loadOrt(runtime);
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(join(model, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(join(model, 'tokenizer_config.json'), 'utf8')),
  );
  const session = await ort.InferenceSession.create(join(model, 'onnx', 'model_quantized.onnx'), { executionProviders: ['cpu'] });
  return buildPipeline(tokenizer, session, (data, dims) => new ort.Tensor('int64', data, dims));
}
