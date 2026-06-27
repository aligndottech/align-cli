import { afterEach, describe, expect, it, vi } from 'vitest';

// @xenova/transformers is an optionalDependency (its native deps - sharp,
// onnxruntime - can fail to install on Alpine/ARM/behind a proxy). getEmbedding
// must therefore surface a clear, actionable error when the model package is
// missing or the model can't be downloaded - never a raw module/network error.
describe('getEmbedding error surfacing (launch packaging)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@xenova/transformers');
  });

  it('throws a clear, actionable error when the ML model package is not installed', async () => {
    vi.doMock('@xenova/transformers', () => {
      throw new Error("Cannot find module '@xenova/transformers'");
    });
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/not installed on this platform|cloud mode/i);
  });

  it('surfaces a clear error when the model fails to load or download', async () => {
    vi.doMock('@xenova/transformers', () => ({
      pipeline: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND huggingface.co')),
    }));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/embedding model|download|connection|proxy/i);
  });
});
