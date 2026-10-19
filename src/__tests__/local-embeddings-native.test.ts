import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingAssetsMissing } from '../lib/embedding-runtime.js';
import { markHookContext, resetHookContextForTests } from '../lib/hook-context.js';
import { buildPipeline, createNativeEmbeddingPipeline, type SessionLike } from '../lib/local-embeddings-native.js';

const D = 384;
// A hidden state where token i carries the constant (i + 1) in every dimension, so pooling
// arithmetic is exact and easy to read.
function fakeSession(n: number): { session: SessionLike; feeds: Array<Record<string, { data: BigInt64Array; dims: number[] }>> } {
  const feeds: Array<Record<string, { data: BigInt64Array; dims: number[] }>> = [];
  const session: SessionLike = {
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['last_hidden_state'],
    run: async (f) => {
      feeds.push(f as never);
      const tokens = (f['input_ids'] as { dims: number[] }).dims[1]!;
      const hidden = new Float32Array(tokens * D);
      for (let i = 0; i < tokens; i++) hidden.fill(i + 1, i * D, (i + 1) * D);
      return { last_hidden_state: { data: hidden } };
    },
  };
  void n;
  return { session, feeds };
}
const makeInt64 = (data: BigInt64Array, dims: number[]) => ({ data, dims });
const enc = (ids: number[], mask = ids.map(() => 1)) => ({ encode: () => ({ ids, tokens: [], attention_mask: mask }) as never });

describe('buildPipeline (the part transformers.js used to do)', () => {
  it('feeds input_ids, attention_mask and an all-zero token_type_ids as int64 [1, n]', async () => {
    const { session, feeds } = fakeSession(0);
    await buildPipeline(enc([101, 7, 102]), session, makeInt64)('x', {});
    const f = feeds[0]!;
    expect(Array.from(f['input_ids']!.data)).toEqual([101n, 7n, 102n]);
    expect(Array.from(f['attention_mask']!.data)).toEqual([1n, 1n, 1n]);
    expect(Array.from(f['token_type_ids']!.data)).toEqual([0n, 0n, 0n]);
    expect(f['input_ids']!.dims).toEqual([1, 3]);
  });

  it('mean-pools over attended tokens only, then L2-normalises (unit vector)', async () => {
    const { session } = fakeSession(0);
    // token values 1,2,3 -> attended 1 and 3 -> mean 2 in every dim -> normalised 1/sqrt(384)
    const [{ data }] = await buildPipeline(enc([1, 2, 3], [1, 0, 1]), session, makeInt64)('x', {});
    expect(data.length).toBe(D);
    expect(data[0]).toBeCloseTo(1 / Math.sqrt(D), 6);
    expect(Math.hypot(...Array.from(data))).toBeCloseTo(1, 5);
  });

  it('keeps the direction of the pooled vector (a non-constant hidden state)', async () => {
    const { session } = fakeSession(0);
    const hidden = new Float32Array(2 * D);
    hidden[0] = 4; // token 0, dim 0; everything else zero
    const s: SessionLike = { ...session, run: async () => ({ last_hidden_state: { data: hidden } }) };
    const [{ data }] = await buildPipeline(enc([1, 2]), s, makeInt64)('x', {});
    expect(data[0]).toBeCloseTo(1, 6); // mean [2,0,...] -> unit vector along dim 0
    expect(data[1]).toBeCloseTo(0, 6);
  });

  // transformers.js truncates with a plain slice and does NOT put [SEP] back. Stored vectors
  // were written that way, so restoring it would shift every long decision's vector.
  it('truncates to 512 tokens by plain slice, without restoring the trailing [SEP]', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => (i === 599 ? 102 : 1000 + i));
    const { session, feeds } = fakeSession(0);
    await buildPipeline(enc(ids), session, makeInt64)('long', {});
    const sent = Array.from(feeds[0]!['input_ids']!.data);
    expect(sent.length).toBe(512);
    expect(sent[511]).toBe(BigInt(1000 + 511));
    expect(sent).not.toContain(102n);
  });

  it('leaves a text of exactly 512 tokens untouched, and 511 too (boundary)', async () => {
    for (const n of [511, 512]) {
      const { session, feeds } = fakeSession(0);
      await buildPipeline(enc(Array.from({ length: n }, (_, i) => i + 1)), session, makeInt64)('x', {});
      expect(feeds[0]!['input_ids']!.dims).toEqual([1, n]);
    }
  });

  it('refuses a tokenizer result with nothing attended rather than returning NaN', async () => {
    const { session } = fakeSession(0);
    await expect(buildPipeline(enc([1], [0]), session, makeInt64)('x', {})).rejects.toThrow(/no attended tokens/);
  });
});

describe('createNativeEmbeddingPipeline in an agent hook', () => {
  afterEach(() => { resetHookContextForTests(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('never downloads: an empty cache fails fast as "not downloaded", with zero network calls', async () => {
    markHookContext();
    vi.stubEnv('ALIGN_MODEL_CACHE', mkdtempSync(join(tmpdir(), 'hook-cache-')));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = await createNativeEmbeddingPipeline().catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingAssetsMissing);
    expect((err as EmbeddingAssetsMissing).reason).toBe('not-downloaded');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
