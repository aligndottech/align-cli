import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelDir, type ModelFile, runtimeDir } from '../lib/embedding-assets.js';
import { EmbeddingAssetsMissing, ensureModel, ensureRuntime, loadOrt } from '../lib/embedding-runtime.js';
import { modelCacheDir } from '../lib/model-cache.js';
import { writeTar } from '../lib/tar-lite.js';
import { DownloadError } from '../lib/verified-download.js';

import { rmSync as rmSyncSafe } from 'node:fs';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

const FAKE_TAR = writeTar([
  { path: 'package.json', data: Buffer.from('{"name":"fake-ort","main":"dist/index.js"}') },
  { path: 'dist/index.js', data: Buffer.from('module.exports = { marker: "fake-ort", InferenceSession: {}, Tensor: class {} };') },
]);
const PINS = { runtimeSha256: { 'linux-x64': sha(FAKE_TAR) } };
const MODEL_BYTES: Record<string, Buffer> = { 'onnx/model_quantized.onnx': Buffer.from('weights'), 'tokenizer.json': Buffer.from('{}'), 'tokenizer_config.json': Buffer.from('{}') };
const MODEL_PINS: ModelFile[] = Object.entries(MODEL_BYTES).map(([path, b]) => ({ path, sha256: sha(b), maxBytes: 1000 }));

let server: Server;
let base: string;
let hits: string[];
let tamper = false;
beforeEach(async () => {
  hits = [];
  tamper = false;
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const url = req.url ?? '';
    if (url.endsWith('.tgz')) { res.end(gzipSync(tamper ? Buffer.concat([FAKE_TAR, Buffer.from('x')]) : FAKE_TAR)); return; }
    const file = Object.keys(MODEL_BYTES).find((p) => url.endsWith(`/${p}`));
    if (file) { res.end(tamper ? Buffer.from('evil') : MODEL_BYTES[file]); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => { server.closeAllConnections(); server.close(); });

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'align-cache-'));
const env = (xdg: string) => ({ XDG_CACHE_HOME: xdg, ALIGN_ORT_RUNTIME_URL: base, HF_ENDPOINT: base }) as Record<string, string | undefined>;
const opts = (xdg: string, extra = {}) => ({ allowDownload: true, env: env(xdg), platform: 'linux', arch: 'x64', pins: { ...PINS, modelFiles: MODEL_PINS }, ...extra });

describe('cache location (never inside node_modules)', () => {
  it('honours XDG_CACHE_HOME', () => {
    expect(modelCacheDir({ XDG_CACHE_HOME: '/x/cache' }, 'linux', '/home/u')).toBe(join('/x/cache', 'align-cli', 'models'));
  });
  it('falls back to ~/.cache, and to %LOCALAPPDATA% on Windows', () => {
    expect(modelCacheDir({}, 'linux', '/home/u')).toBe(join('/home/u', '.cache', 'align-cli', 'models'));
    expect(modelCacheDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe(join('C:\\L', 'align-cli', 'models'));
  });
  it('lets ALIGN_MODEL_CACHE override everything', () => {
    expect(modelCacheDir({ ALIGN_MODEL_CACHE: '/m', XDG_CACHE_HOME: '/x' }, 'linux', '/h')).toBe('/m');
  });
  it('downloads land under the XDG cache dir, and nowhere in the package tree', async () => {
    const xdg = tmpRoot();
    const dir = await ensureRuntime(opts(xdg));
    const modelPath = await ensureModel(opts(xdg));
    for (const p of [dir, modelPath]) {
      expect(resolve(p).startsWith(resolve(xdg))).toBe(true);
      expect(p).not.toMatch(/node_modules/);
    }
    // And the default root is outside this checkout's tree too (an install tree is node_modules
    // under some prefix; the default is the user cache dir).
    expect(modelCacheDir({}, process.platform, homedir())).not.toMatch(/node_modules/);
  });
});

describe('ensureRuntime', () => {
  it('downloads once, verifies, and then works offline from the cache', async () => {
    const xdg = tmpRoot();
    const dir = await ensureRuntime(opts(xdg));
    expect(dir).toBe(runtimeDir(join(xdg, 'align-cli', 'models'), 'linux-x64'));
    expect(loadOrt(dir)).toMatchObject({ marker: 'fake-ort' });
    expect(hits.length).toBe(1);
    server.closeAllConnections(); server.close();
    await expect(ensureRuntime(opts(xdg, { env: { ...env(xdg), ALIGN_ORT_RUNTIME_URL: 'http://127.0.0.1:9' } }))).resolves.toBe(dir);
    expect(hits.length).toBe(1);
  });

  it('refuses a tampered download: non-zero failure, nothing cached, nothing loadable', async () => {
    const xdg = tmpRoot();
    tamper = true;
    const err = await ensureRuntime(opts(xdg)).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).kind).toBe('checksum');
    const root = join(xdg, 'align-cli', 'models', 'ort');
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
    expect(() => loadOrt(runtimeDir(join(xdg, 'align-cli', 'models'), 'linux-x64'))).toThrow();
  });

  it('with no network, fails fast with a clear error and leaves no partial cache', async () => {
    const xdg = tmpRoot();
    const t0 = Date.now();
    const err = await ensureRuntime(opts(xdg, { env: { ...env(xdg), ALIGN_ORT_RUNTIME_URL: 'http://127.0.0.1:9' } })).catch((e) => e);
    expect((err as DownloadError).kind).toBe('network');
    expect(String(err.message)).toMatch(/could not reach 127\.0\.0\.1/);
    expect(Date.now() - t0).toBeLessThan(5000);
    const root = join(xdg, 'align-cli', 'models', 'ort');
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });

  it('in a hook (allowDownload: false) never touches the network', async () => {
    const xdg = tmpRoot();
    const fetchImpl = vi.fn();
    const err = await ensureRuntime(opts(xdg, { allowDownload: false, fetchImpl })).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingAssetsMissing);
    expect((err as EmbeddingAssetsMissing).reason).toBe('not-downloaded');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(hits).toEqual([]);
  });

  it('a platform with no published runtime is reported as unsupported, not as a network problem', async () => {
    const err = await ensureRuntime(opts(tmpRoot(), { platform: 'sunos', arch: 'sparc' })).catch((e) => e);
    expect((err as EmbeddingAssetsMissing).reason).toBe('unsupported-platform');
  });

  it('two processes racing the first run both end with a complete runtime and no temp litter', async () => {
    const xdg = tmpRoot();
    const [a, b] = await Promise.all([ensureRuntime(opts(xdg)), ensureRuntime(opts(xdg))]);
    expect(a).toBe(b);
    expect(loadOrt(a)).toMatchObject({ marker: 'fake-ort' });
    expect(readdirSync(join(xdg, 'align-cli', 'models', 'ort'))).toEqual(['1.30.0-linux-x64']);
  });

  it('heals a stale or damaged cache: a wrong marker is never trusted, and the next run replaces it', async () => {
    const xdg = tmpRoot();
    const dir = await ensureRuntime(opts(xdg));
    writeFileSync(join(dir, '.verified'), 'stale\n');
    expect(await ensureRuntime(opts(xdg))).toBe(dir);
    expect(readFileSync(join(dir, '.verified'), 'utf8')).not.toBe('stale\n');
    expect(loadOrt(dir)).toMatchObject({ marker: 'fake-ort' });
    expect(hits.length).toBe(2); // re-fetched, not trusted
  });
});

// The cache holds CODE the CLI loads. A directory that merely carries a copied `.verified`
// (a hostile repo's, a shared /tmp's) must never be trusted, whatever env points at it.
describe('the cache is only trusted if it is exactly what was verified', () => {
  const heal = async (mutate: (dir: string) => void) => {
    const xdg = tmpRoot();
    const dir = await ensureRuntime(opts(xdg));
    mutate(dir);
    const before = hits.length;
    expect(await ensureRuntime(opts(xdg))).toBe(dir);
    expect(hits.length).toBe(before + 1); // not trusted: fetched again
    expect(loadOrt(dir)).toMatchObject({ marker: 'fake-ort' });
    return dir;
  };

  it('a file swapped for different bytes of another size is not trusted', async () => {
    await heal((d) => writeFileSync(join(d, 'dist', 'index.js'), 'require("child_process").exec("evil")'));
  });
  it('an extra planted file is not trusted', async () => {
    await heal((d) => writeFileSync(join(d, 'dist', 'extra.js'), 'x'));
  });
  it.skipIf(process.platform === 'win32')('a symlink in place of a file is not trusted', async () => {
    await heal((d) => { writeFileSync(join(d, 'real.js'), 'x'); cpSync(join(d, 'dist', 'index.js'), join(d, 'orig.js')); rmSyncSafe(join(d, 'dist', 'index.js')); symlinkSync(join(d, 'orig.js'), join(d, 'dist', 'index.js')); });
  });
  it.skipIf(process.platform === 'win32')('an entry anyone but the owner can write is not trusted', async () => {
    await heal((d) => chmodSync(join(d, 'dist', 'index.js'), 0o666));
  });

  it('a `.verified` copied from another cache into a hostile directory is not trusted', async () => {
    const xdg = tmpRoot();
    const good = await ensureRuntime(opts(xdg));
    const evil = tmpRoot();
    const target = runtimeDir(join(evil, 'align-cli', 'models'), 'linux-x64');
    mkdirSync(join(target, 'dist'), { recursive: true });
    writeFileSync(join(target, 'dist', 'index.js'), 'module.exports = { marker: "evil" };');
    writeFileSync(join(target, 'package.json'), '{}');
    cpSync(join(good, '.verified'), join(target, '.verified'));
    await ensureRuntime(opts(evil));
    expect(loadOrt(target)).toMatchObject({ marker: 'fake-ort' }); // replaced by the verified download
  });

  it('removes stale temp dirs from interrupted runs, and leaves fresh ones (a run in progress)', async () => {
    const xdg = tmpRoot();
    const ort = join(xdg, 'align-cli', 'models', 'ort');
    mkdirSync(join(ort, '.tmp-old'), { recursive: true });
    mkdirSync(join(ort, '.tmp-fresh'), { recursive: true });
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(ort, '.tmp-old'), old, old);
    await ensureRuntime(opts(xdg));
    expect(readdirSync(ort).sort()).toEqual(['.tmp-fresh', '1.30.0-linux-x64']);
  });
});

describe('ALIGN_MODEL_CACHE must be absolute', () => {
  it('ignores a relative override, which a repo .env could point at the repo itself', () => {
    expect(modelCacheDir({ ALIGN_MODEL_CACHE: '.cache', XDG_CACHE_HOME: '/x' }, 'linux', '/h')).toBe(join('/x', 'align-cli', 'models'));
    expect(modelCacheDir({ ALIGN_MODEL_CACHE: '../up' }, 'linux', '/h')).toBe(join('/h', '.cache', 'align-cli', 'models'));
  });
  it('accepts POSIX and Windows absolute forms', () => {
    expect(modelCacheDir({ ALIGN_MODEL_CACHE: '/abs/c' })).toBe('/abs/c');
    expect(modelCacheDir({ ALIGN_MODEL_CACHE: 'D:\\cache' })).toBe('D:\\cache');
  });
});

describe('ensureModel', () => {
  it('downloads the pinned files by commit into the cache and serves them offline afterwards', async () => {
    const xdg = tmpRoot();
    const dir = await ensureModel(opts(xdg));
    expect(dir).toBe(modelDir(join(xdg, 'align-cli', 'models')));
    expect(readFileSync(join(dir, 'onnx', 'model_quantized.onnx'), 'utf8')).toBe('weights');
    expect(hits.every((h) => /\/resolve\/[0-9a-f]{40}\//.test(h))).toBe(true);
    const n = hits.length;
    await ensureModel(opts(xdg));
    expect(hits.length).toBe(n);
  });

  it('refuses tampered weights and caches nothing', async () => {
    const xdg = tmpRoot();
    tamper = true;
    await expect(ensureModel(opts(xdg))).rejects.toMatchObject({ kind: 'checksum' });
    const root = join(xdg, 'align-cli', 'models', 'hf');
    expect(existsSync(root) ? readdirSync(root, { recursive: true }).filter((f) => String(f).includes('model_quantized')) : []).toEqual([]);
  });

  it('in a hook never downloads', async () => {
    await expect(ensureModel(opts(tmpRoot(), { allowDownload: false }))).rejects.toBeInstanceOf(EmbeddingAssetsMissing);
    expect(hits).toEqual([]);
  });
});
