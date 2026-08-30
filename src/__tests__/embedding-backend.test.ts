import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEmbedding, resetEmbeddingBackend, setEmbeddingBackend } from '../lib/local-embeddings.js';

// ALI-744: the standalone binary cannot load @huggingface/transformers' native path, so it
// injects a WASM backend at startup. These pin the seam itself; that the WASM backend really
// produces vectors is proven against a compiled artifact in scripts/smoke-binary.sh, which is
// the only place the embedded ORT assets exist.
describe('embedding backend injection', () => {
  afterEach(() => { resetEmbeddingBackend(); vi.restoreAllMocks(); });

  it('uses an injected backend instead of the default loader', async () => {
    const pipe = vi.fn().mockResolvedValue([{ data: new Float32Array([1, 2, 3]) }]);
    setEmbeddingBackend(async () => pipe as never);
    const v = await getEmbedding('hello');
    expect(Array.from(v)).toEqual([1, 2, 3]);
    expect(pipe).toHaveBeenCalledWith('hello', { pooling: 'mean', normalize: true });
  });

  it('builds the pipeline once and reuses it across calls', async () => {
    const pipe = vi.fn().mockResolvedValue([{ data: new Float32Array([1]) }]);
    const backend = vi.fn().mockResolvedValue(pipe);
    setEmbeddingBackend(backend as never);
    await getEmbedding('a');
    await getEmbedding('b');
    expect(backend).toHaveBeenCalledTimes(1);
    expect(pipe).toHaveBeenCalledTimes(2);
  });

  // Without this, registering a backend after something had already embedded would keep
  // serving vectors from the previous model - the silent-divergence failure cosineSimilarity
  // exists to shout about, one layer earlier.
  it('discards a pipeline built by a previous backend when a new one is registered', async () => {
    const first = vi.fn().mockResolvedValue([{ data: new Float32Array([1]) }]);
    setEmbeddingBackend(async () => first as never);
    await getEmbedding('a');
    const second = vi.fn().mockResolvedValue([{ data: new Float32Array([9]) }]);
    setEmbeddingBackend(async () => second as never);
    expect(Array.from(await getEmbedding('a'))).toEqual([9]);
    expect(first).toHaveBeenCalledTimes(1);
  });
});
