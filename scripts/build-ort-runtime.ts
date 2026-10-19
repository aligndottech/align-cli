/**
 * Build the per-platform ONNX Runtime bundles the CLI downloads on first local use (ALI-1781).
 *
 *   npx tsx scripts/build-ort-runtime.ts --out <dir> [--check]
 *
 * Takes the two upstream npm tarballs (fetched with `npm pack`, which runs no install script),
 * checks them against the integrity pinned in src/lib/embedding-assets.ts, and cuts one
 * reproducible tar.gz per platform: the CPU runtime library, the N-API binding and the small JS
 * wrapper - and nothing else. No CUDA/TensorRT/DirectML providers, no source maps, no types.
 *
 * `--check` fails unless every bundle's digest equals RUNTIME_SHA256. The release workflow runs
 * it before uploading, so an asset can never differ from what the CLI is willing to trust.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ORT_COMMON_NPM_INTEGRITY, ORT_NODE_NPM_INTEGRITY, ORT_VERSION, RUNTIME_SHA256, runtimeAssetName } from '../src/lib/embedding-assets.js';
import { type TarEntry, writeTar } from '../src/lib/tar-lite.js';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = flag('--out');
if (!out) { console.error('usage: build-ort-runtime.ts --out <dir> [--check]'); process.exit(2); }
mkdirSync(out, { recursive: true });

// Per platform: files in bin/napi-v6/<p>/<a>/ that CPU inference never loads.
const EXCLUDE = new Set([
  'libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so', // 272MB + 1MB
  'libonnxruntime.1.30.0.dylib',   // byte-identical copy of libonnxruntime.1.dylib, the only name the binding asks for
  'DirectML.dll', 'dxcompiler.dll', 'dxil.dll', // delay-loaded by onnxruntime.dll, only when the DML provider is requested
]);

function pack(spec: string, integrity: string, dir: string): string {
  // shell on win32 only: npm is npm.cmd there, which execFile cannot launch directly.
  const file = execFileSync('npm', ['pack', spec, '--pack-destination', dir, '--silent', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop()!;
  const path = join(dir, file);
  const actual = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
  if (actual !== integrity) throw new Error(`${spec}: tarball integrity ${actual} does not match the pinned ${integrity}`);
  // Relative names with cwd set: GNU tar on Windows (Git Bash) reads "C:\\..." as host:path and fails
  // ("Cannot connect to C"), and bsdtar/GNU tar agree on plain relative arguments.
  const name = file.replace(/\.tgz$/, '');
  mkdirSync(join(dir, name));
  execFileSync('tar', ['-xzf', file, '-C', name, '--strip-components=1'], { cwd: dir });
  const dest = join(dir, name);
  return dest;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

const work = mkdtempSync(join(tmpdir(), 'ort-build-'));
const nodeDir = pack(`onnxruntime-node@${ORT_VERSION}`, ORT_NODE_NPM_INTEGRITY, work);
const commonDir = pack(`onnxruntime-common@${ORT_VERSION}`, ORT_COMMON_NPM_INTEGRITY, work);

const platforms = readdirSync(join(nodeDir, 'bin/napi-v6')).flatMap((p) =>
  readdirSync(join(nodeDir, 'bin/napi-v6', p)).map((a) => [p, a] as const));

const sums: Record<string, string> = {};
let bad = 0;
for (const [p, a] of platforms) {
  const key = `${p}-${a}`;
  const entries: TarEntry[] = [];
  const add = (path: string, file: string, mode = 0o644) => entries.push({ path, data: readFileSync(file), mode });
  entries.push({ path: 'package.json', data: Buffer.from(`${JSON.stringify({ name: 'align-ort-runtime', version: ORT_VERSION, private: true, main: 'dist/index.js' })  }\n`) });
  for (const f of walk(join(nodeDir, 'dist'))) if (f.endsWith('.js')) add(`dist/${relative(join(nodeDir, 'dist'), f)}`, f);
  const binDir = join(nodeDir, 'bin/napi-v6', p, a);
  for (const f of readdirSync(binDir)) if (!EXCLUDE.has(f) && statSync(join(binDir, f)).isFile()) add(`bin/napi-v6/${p}/${a}/${f}`, join(binDir, f), 0o755);
  add('node_modules/onnxruntime-common/package.json', join(commonDir, 'package.json'));
  for (const f of walk(join(commonDir, 'dist/cjs'))) if (f.endsWith('.js') || f.endsWith('.json')) add(`node_modules/onnxruntime-common/dist/cjs/${relative(join(commonDir, 'dist/cjs'), f)}`, f);
  const tar = writeTar(entries);
  const sha = createHash('sha256').update(tar).digest('hex');
  sums[key] = sha;
  writeFileSync(join(out, runtimeAssetName(key)), gzipSync(tar, { level: 9 }));
  const ok = RUNTIME_SHA256[key] === sha;
  if (args.includes('--check') && !ok) bad++;
  console.log(`${key}\t${(tar.length / 1048576).toFixed(1)} MB tar\t${sha}\t${ok ? 'matches pinned' : 'DIFFERS from pinned'}`);
}
writeFileSync(join(out, 'ort-runtime-sha256.json'), `${JSON.stringify(sums, null, 2)  }\n`);
if (bad) { console.error(`${bad} bundle(s) differ from RUNTIME_SHA256 in src/lib/embedding-assets.ts`); process.exit(1); }
