/**
 * #720: on node:22.19-alpine the native ONNX Runtime needs glibc, the load failed with a dynamic-loader error, and the
 * CLI blamed the internet connection. Test List:
 * 1. isMuslLinux: linux with no glibc in the process report is musl (two shapes: Alpine report, glibc report), other platforms never
 * 2. isLoaderFailure: the loader's own words are recognised (two shapes: glibc missing, symbol missing), a network error is not
 * 3. local mode on musl fails BEFORE any download, naming glibc and the fix
 * 4. a loader failure from the runtime is reported as the glibc requirement, not as a connection problem (and a network error still is one)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as LibcModule from '../lib/libc.js';

const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../lib/local-embeddings-native.js', () => ({ createNativeEmbeddingPipeline: native.create }));

const LOADER = 'Error loading shared library ld-linux-x86-64.so.2: No such file or directory (needed by /c/ort/bin/napi-v6/linux/x64//libonnxruntime.so.1)';

describe('isMuslLinux', () => {
  it('is true on linux when the process report names no glibc (Alpine)', async () => {
    const { isMuslLinux } = await import('../lib/libc.js');
    expect(isMuslLinux('linux', { header: {} })).toBe(true);
  });
  it('is false on linux when the report names a glibc version (Debian)', async () => {
    const { isMuslLinux } = await import('../lib/libc.js');
    expect(isMuslLinux('linux', { header: { glibcVersionRuntime: '2.36' } })).toBe(false);
  });
  it('is false off linux, whatever the report says', async () => {
    const { isMuslLinux } = await import('../lib/libc.js');
    expect(isMuslLinux('darwin', { header: {} })).toBe(false);
    expect(isMuslLinux('win32', { header: {} })).toBe(false);
  });
  it('is false when no report can be read, because a guess would block a working machine', async () => {
    const { isMuslLinux } = await import('../lib/libc.js');
    expect(isMuslLinux('linux', undefined)).toBe(false);
  });
});

describe('isLoaderFailure', () => {
  it('recognises a missing glibc loader and a missing glibc symbol', async () => {
    const { isLoaderFailure } = await import('../lib/libc.js');
    expect(isLoaderFailure(LOADER)).toBe(true);
    expect(isLoaderFailure('Error relocating /c/libonnxruntime.so.1: __memcpy_chk: symbol not found')).toBe(true);
  });
  it('does not take a network error for one', async () => {
    const { isLoaderFailure } = await import('../lib/libc.js');
    expect(isLoaderFailure('could not reach github.com: getaddrinfo ENOTFOUND')).toBe(false);
    expect(isLoaderFailure('fetch failed')).toBe(false);
  });
});

describe('local mode on a system without glibc', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../lib/libc.js');
    native.create.mockReset();
  });

  it('stops before any download on musl, names glibc and the fix, and points at cloud mode', async () => {
    vi.doMock('../lib/libc.js', async (orig) => ({ ...(await orig<typeof LibcModule>()), isMuslLinux: () => true }));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/glibc[\s\S]*node:22-bookworm-slim[\s\S]*align login/);
    expect(native.create).not.toHaveBeenCalled();
  });

  it('reports a loader failure from the runtime as the glibc requirement, not as an internet problem', async () => {
    native.create.mockRejectedValue(new Error(LOADER));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    const err = await getEmbedding('hello').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/glibc[\s\S]*node:22-bookworm-slim/);
    expect((err as Error).message).not.toMatch(/internet connection/);
    expect((err as Error).message).toContain('ld-linux-x86-64.so.2');
  });

  it('still reports a network error as a connection problem', async () => {
    native.create.mockRejectedValue(new Error('could not reach github.com: getaddrinfo ENOTFOUND'));
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await expect(getEmbedding('hello')).rejects.toThrow(/internet connection/);
  });
});
