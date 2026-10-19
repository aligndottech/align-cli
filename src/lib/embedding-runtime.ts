/**
 * Fetch, verify, cache and load the two things on-device embeddings need that npm no longer
 * ships (ALI-1781): the native ONNX Runtime for THIS os/arch, and the model files.
 *
 * Contract:
 *  - Every byte is checked against a digest pinned in embedding-assets.ts BEFORE it touches the
 *    cache. A mismatch throws and leaves nothing behind.
 *  - Writes go to a private temp dir beside the target and are renamed into place, so a crash,
 *    Ctrl-C or a second process racing the first never leaves a half-written cache that a later
 *    run would load.
 *  - Nothing is written under the install tree, ever (model-cache.ts: modelCacheDir).
 *  - `allowDownload: false` (agent hooks) never touches the network: a hook runs on every edit
 *    and must not stall the edit on a 20MB download. It throws EmbeddingAssetsMissing instead,
 *    which the advisory hook already reports as "could not check" and exits 0.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  MODEL_FILES, MODEL_REVISION, modelDir, type ModelFile, modelFileUrl, ORT_VERSION, RUNTIME_LIMITS, RUNTIME_SHA256, runtimeDir,
  runtimeKey, runtimeUrl,
} from './embedding-assets.js';
import { modelCacheDir } from './model-cache.js';
import { ensurePrivateDir } from './private-files.js';
import { extractTar } from './tar-lite.js';
import { fetchVerified } from './verified-download.js';

/** The cache is empty and this process may not fill it (hook), or the platform has no runtime. */
export class EmbeddingAssetsMissing extends Error {
  constructor(message: string, readonly reason: 'not-downloaded' | 'unsupported-platform') {
    super(message);
    this.name = 'EmbeddingAssetsMissing';
  }
}

export interface EnsureOptions {
  allowDownload: boolean;
  env?: Record<string, string | undefined>;
  /** Cache root override (tests). Defaults to modelCacheDir(env, opts.platform ?? process.platform). */
  root?: string;
  platform?: string;
  arch?: string;
  fetchImpl?: typeof fetch;
  /** One-line progress notice, shown only when a download actually starts. */
  notice?: (message: string) => void;
  /** Test seam: swap the pinned digests for a tiny fixture. Production never sets it. */
  pins?: { runtimeSha256?: Readonly<Record<string, string>>; modelFiles?: readonly ModelFile[] };
}

const MARKER = '.verified';

function marker(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface Listed { rel: string; size: number }

/** Every entry under `dir` except the marker, as [relative path, size]. Throws on anything that is
 *  not a plain file or directory (a symlink, a device), and on loose ownership or modes. */
function listTree(dir: string, rel = ''): Listed[] {
  const out: Listed[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const name of readdirSync(join(dir, rel))) {
    if (rel === '' && name === MARKER) continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) throw new Error(`symlink in cache: ${r}`);
    // POSIX only: a cache entry another user owns, or anyone but the owner may write, is not ours.
    if (uid !== null && (st.uid !== uid || (st.mode & 0o022) !== 0)) throw new Error(`cache entry not exclusively ours: ${r}`);
    if (st.isDirectory()) out.push(...listTree(dir, r));
    else if (st.isFile()) out.push({ rel: r, size: st.size });
    else throw new Error(`unexpected file type in cache: ${r}`);
  }
  return out;
}

/** The marker is not just a flag: it records the digest it was written for AND the exact file list
 *  with sizes, so a directory that merely contains a copied `.verified` (a repo's, a shared /tmp's)
 *  is not trusted, and neither is one with a file added, swapped for a symlink or resized. It does
 *  not re-hash the 46MB (the load runs on every edit hook), so a same-user attacker who preserves
 *  sizes is out of scope: that user can edit the CLI itself. `align doctor` re-hashes the model. */
function writeMarker(dir: string, digest: string): void {
  const files = listTree(dir).map((f) => [f.rel, f.size]).sort();
  writeFileSync(join(dir, MARKER), `${JSON.stringify({ marker: digest, files })}\n`, { mode: 0o644 });
}

function isComplete(dir: string, expected: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { marker?: string; files?: Array<[string, number]> };
    if (m.marker !== expected || !Array.isArray(m.files)) return false;
    const have = listTree(dir).map((f) => [f.rel, f.size]).sort();
    return JSON.stringify(have) === JSON.stringify([...m.files].sort());
  } catch {
    return false;
  }
}

/** Windows antivirus and indexers hold freshly written files; a rename then fails with a transient
 *  EPERM/EBUSY/EACCES that goes away within moments. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (attempt >= 8 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

/** Interrupted extractions leave `.tmp-*` siblings (up to ~46MB each). Remove old ones. */
function sweepStaleTemps(parent: string): void {
  try {
    for (const name of readdirSync(parent)) {
      if (!name.startsWith('.tmp-')) continue;
      const st = statSync(join(parent, name));
      if (Date.now() - st.mtimeMs > 3_600_000) rmSync(join(parent, name), { recursive: true, force: true });
    }
  } catch { /* nothing to sweep, or a race with another process: both fine */ }
}

function tempSibling(target: string): string {
  return join(dirname(target), `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
}

/** Publish `tmp` as `target`. A concurrent run that got there first wins, provided what it left
 *  is complete. A target that exists but is NOT complete (a stale or damaged cache) is replaced,
 *  so a bad cache heals on the next run instead of failing every run after it. */
function publish(tmp: string, target: string, expectedMarker: string): void {
  try {
    renameWithRetry(tmp, target);
    return;
  } catch (err) {
    if (isComplete(target, expectedMarker)) { rmSync(tmp, { recursive: true, force: true }); return; }
    if (!existsSync(target)) { rmSync(tmp, { recursive: true, force: true }); throw err; }
  }
  try {
    rmSync(target, { recursive: true, force: true });
    renameWithRetry(tmp, target);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!isComplete(target, expectedMarker)) throw err;
  }
}

export async function ensureRuntime(opts: EnsureOptions): Promise<string> {
  const env = opts.env ?? process.env;
  const key = runtimeKey(opts.platform, opts.arch, opts.pins?.runtimeSha256);
  if (!key) {
    throw new EmbeddingAssetsMissing(
      `No on-device embedding runtime is published for ${opts.platform ?? process.platform}-${opts.arch ?? process.arch} ` +
      '(supported: glibc Linux x64/arm64, macOS arm64, Windows x64/arm64).',
      'unsupported-platform',
    );
  }
  const root = opts.root ?? modelCacheDir(env, opts.platform ?? process.platform);
  const digest = (opts.pins?.runtimeSha256 ?? RUNTIME_SHA256)[key]!;
  const target = runtimeDir(root, key);
  const want = marker(digest);
  if (isComplete(target, want)) return target;
  if (!opts.allowDownload) {
    throw new EmbeddingAssetsMissing(
      `The on-device embedding runtime (ONNX Runtime ${ORT_VERSION}) is not downloaded yet. Run \`align doctor\` or any local command (for example \`align ask\`) once, outside an agent hook, to fetch it.`,
      'not-downloaded',
    );
  }
  opts.notice?.(`Downloading the on-device embedding runtime (ONNX Runtime ${ORT_VERSION}, ${key}), one time...`);
  const tar = await fetchVerified(runtimeUrl(key, env), {
    sha256: digest, maxBytes: RUNTIME_LIMITS.maxTotalBytes, gunzip: true, fetchImpl: opts.fetchImpl,
  });
  ensurePrivateDir(dirname(target));
  sweepStaleTemps(dirname(target));
  const tmp = tempSibling(target);
  try {
    extractTar(tar, tmp, RUNTIME_LIMITS);
    writeMarker(tmp, want);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  publish(tmp, target, want);
  return target;
}

function modelMarker(files: readonly ModelFile[]): string {
  return marker(`${MODEL_REVISION}\n${files.map((f) => `${f.path} ${f.sha256}`).join('\n')}`);
}

export async function ensureModel(opts: EnsureOptions): Promise<string> {
  const env = opts.env ?? process.env;
  const root = opts.root ?? modelCacheDir(env, opts.platform ?? process.platform);
  const target = modelDir(root);
  const files = opts.pins?.modelFiles ?? MODEL_FILES;
  const want = modelMarker(files);
  if (isComplete(target, want)) return target;
  if (!opts.allowDownload) {
    throw new EmbeddingAssetsMissing(
      'The on-device embedding model is not downloaded yet. Run `align doctor` or any local command (for example `align ask`) once, outside an agent hook, to fetch it.',
      'not-downloaded',
    );
  }
  opts.notice?.('Downloading the on-device embedding model (~23MB, Xenova/all-MiniLM-L6-v2), one time...');
  const fetched: Array<[ModelFile, Buffer]> = [];
  for (const f of files) {
    fetched.push([f, await fetchVerified(modelFileUrl(f, env), { sha256: f.sha256, maxBytes: f.maxBytes, fetchImpl: opts.fetchImpl })]);
  }
  ensurePrivateDir(dirname(target));
  sweepStaleTemps(dirname(target));
  const tmp = tempSibling(target);
  try {
    for (const [f, data] of fetched) {
      const dest = join(tmp, f.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      // Explicit mode: the default is 0666 minus umask, which is group-writable under umask 002 (Ubuntu's default).
      writeFileSync(dest, data, { mode: 0o644 });
    }
    writeMarker(tmp, want);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  publish(tmp, target, want);
  return target;
}

export interface OrtApi {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<{
      inputNames: readonly string[];
      outputNames: readonly string[];
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | ArrayLike<number> }>>;
    }>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

/** Load the downloaded wrapper by ABSOLUTE path. The JS inside it resolves its own sibling
 *  `../bin/...` binding and its bundled onnxruntime-common, so nothing here depends on how, or
 *  whether, this package's own node_modules were laid out. */
export function loadOrt(dir: string): OrtApi {
  const entry = join(dir, 'dist', 'index.js');
  if (!existsSync(entry)) throw new Error(`runtime bundle at ${dir} has no dist/index.js`);
  return createRequire(join(dir, 'package.json'))(entry) as OrtApi;
}
