import { afterEach, describe, expect, it, vi } from 'vitest';

// The on-device runtime and model are downloaded on first use. getEmbedding must
// surface a clear, actionable error when the platform has no runtime or the download fails -
// never a raw fetch or dlopen error.
const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../lib/local-embeddings-native.js', () => ({ createNativeEmbeddingPipeline: native.create }));

describe('getEmbedding error surfacing (npm distribution)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../lib/distribution.js');
    native.create.mockReset();
  });

  it('says a platform without a runtime bundle is a platform limit, and points at cloud mode', async () => {
    const { EmbeddingAssetsMissing } = await import('../lib/embedding-runtime.js');
    native.create.mockRejectedValue(new EmbeddingAssetsMissing('No runtime for sunos-x64', 'unsupported-platform'));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/not available on this platform[\s\S]*align login[\s\S]*reinstall on a supported platform/i);
  });

  it('passes the hook-safe "not downloaded yet" message through unchanged', async () => {
    const { EmbeddingAssetsMissing } = await import('../lib/embedding-runtime.js');
    native.create.mockRejectedValue(new EmbeddingAssetsMissing('The on-device embedding runtime is not downloaded yet. Run `align doctor`', 'not-downloaded'));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow('The on-device embedding runtime is not downloaded yet. Run `align doctor`');
  });

  it('surfaces a clear error when the download fails, naming the cause and the cloud fallback', async () => {
    native.create.mockRejectedValue(new Error('could not reach github.com: getaddrinfo ENOTFOUND'));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/embedding model[\s\S]*connection or proxy[\s\S]*align login[\s\S]*ENOTFOUND/i);
  });

  it('shares one setup between concurrent first calls instead of downloading once per caller', async () => {
    let release!: () => void;
    native.create.mockReturnValue(new Promise((r) => { release = () => r(async () => [{ data: new Float32Array(384) }]); }));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    const calls = [getEmbedding('a'), getEmbedding('b'), getEmbedding('c')];
    release();
    await Promise.all(calls);
    expect(native.create).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed setup: the next call tries again', async () => {
    native.create.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(async () => [{ data: new Float32Array(384) }]);
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('a')).rejects.toThrow(/offline/);
    await expect(getEmbedding('a')).resolves.toBeInstanceOf(Float32Array);
  });
});

// The binary bundles a WASM backend and registers it at startup, so it should
// never reach the native loader. If it does, its own build is broken - and the npm-shaped advice
// ("reinstall on a supported platform") is unfollowable for someone who downloaded a binary.
describe('getEmbedding error surfacing (binary distribution)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../lib/distribution.js');
    native.create.mockReset();
  });

  it('names a missing WASM backend as a build defect, not a platform limit, and never tries the native path', async () => {
    vi.doMock('../lib/distribution.js', () => ({ alignDistribution: () => 'binary' }));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/standalone binary did not register/i);
    expect(native.create).not.toHaveBeenCalled();
  });
});
