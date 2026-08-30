import { afterEach, describe, expect, it, vi } from 'vitest';

// @huggingface/transformers is an optionalDependency (its native deps - sharp,
// onnxruntime - can fail to install on Alpine/ARM/behind a proxy). getEmbedding
// must therefore surface a clear, actionable error when the model package is
// missing or the model can't be downloaded - never a raw module/network error.
describe('getEmbedding error surfacing (launch packaging)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@huggingface/transformers');
  });

  it('throws a clear, actionable error when the ML model package is not installed', async () => {
    vi.doMock('@huggingface/transformers', () => {
      throw new Error("Cannot find module '@huggingface/transformers'");
    });
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/not installed on this platform|cloud mode/i);
  });

  it('surfaces a clear error when the model fails to load or download', async () => {
    vi.doMock('@huggingface/transformers', () => ({
      pipeline: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND huggingface.co')),
    }));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/embedding model|download|connection|proxy/i);
  });
});

// ALI-740/744: the binary bundles a WASM backend and registers it at startup, so it should
// never reach the native loader below. If it does, its own build is broken - and the
// npm-shaped advice ("reinstall on a supported platform") is unfollowable for someone who
// downloaded a binary. The message has to name the situation it is actually in.
describe('getEmbedding error surfacing (binary distribution)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@huggingface/transformers');
    vi.doUnmock('../lib/distribution.js');
  });

  it('names a missing WASM backend as a build defect, not a platform limit', async () => {
    vi.doMock('../lib/distribution.js', () => ({ alignDistribution: () => 'binary' }));
    vi.doMock('@huggingface/transformers', () => {
      throw new Error("Cannot find module '@huggingface/transformers'");
    });
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/standalone binary did not register/i);
  });

  it('still gives the npm advice when this is the npm distribution', async () => {
    vi.doMock('../lib/distribution.js', () => ({ alignDistribution: () => 'npm' }));
    vi.doMock('@huggingface/transformers', () => {
      throw new Error("Cannot find module '@huggingface/transformers'");
    });
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/reinstall on a supported platform/i);
  });
});
