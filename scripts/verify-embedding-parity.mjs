#!/usr/bin/env node
/**
 * Vector parity gate (ALI-1781): embed a fixed corpus with the CLI's real loader and require
 * cosine >= 0.9999 against reference vectors from the stack npm installs shipped before
 * (transformers.js 4.3.1 + onnxruntime-node 1.30.0, native, q8).
 *
 * Stored local graphs hold vectors from that stack, so this is the contract: a loader that drifts
 * past it silently makes old decisions unfindable. The corpus includes texts past 512 tokens,
 * where truncation behaviour decides the vector.
 *
 *   node scripts/verify-embedding-parity.mjs [<installed @aligndottech/cli dir>] [--live]
 *
 * Downloads the runtime and model on first run (honours ALIGN_ORT_RUNTIME_URL, HF_ENDPOINT,
 * XDG_CACHE_HOME). Exits 1 on any text under the bar, 2 when nothing could be embedded.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = resolve(process.argv[2] ?? repo);
const fixture = JSON.parse(readFileSync(join(repo, "src/__tests__/fixtures/embedding-parity.json"), 'utf8'));
const { getEmbedding } = await import(pathToFileURL(join(pkg, "dist/lib/local-embeddings.js")).href);

const BAR = 0.9999;
const live = process.argv.includes('--live');
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };

if (!fixture.items?.length) { console.error('parity fixture is empty: refusing to report a pass over nothing'); process.exit(2); }
console.log(`cpu: ${os.cpus()[0]?.model ?? 'unknown'} (${os.arch()}), node ${process.versions.node}`);

// q8 dynamic quantisation is NOT bit-stable across hardware or ONNX Runtime versions: the same model
// through ORT 1.24.3 vs 1.30.0 differs by min cosine 0.9918 on these texts, and a CI runner's CPU can
// differ from the machine the fixture was cut on (AVX2 vs AVX-512 VNNI kernels). So the strict gate is
// SAME-MACHINE: `--live` computes the reference through transformers.js (a devDependency, ORT pinned
// to 1.30.0 by `overrides`) right here. The committed vectors are checked against a looser floor that
// only catches a wrong model, tokenizer or truncation.
let reference = fixture.items.map((i) => i.vec);
let bar = 0.99;
if (live) {
  const hf = await import(pathToFileURL(join(repo, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
  const pipe = await hf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  reference = [];
  for (const item of fixture.items) reference.push(Array.from((await pipe(item.text, { pooling: 'mean', normalize: true })).data));
  bar = BAR;
}
let min = 1, worst = -1, bad = 0;
for (const [i, item] of fixture.items.entries()) {
  const got = await getEmbedding(item.text);
  if (got.length !== reference[i].length) { console.error(`text ${i}: ${got.length} dims, reference has ${reference[i].length}`); process.exit(1); }
  const c = cos(got, reference[i]);
  if (c < min) { min = c; worst = i; }
  if (!(c >= bar)) bad++;
}
console.log(`parity vs ${live ? 'transformers.js on this machine' : 'committed vectors (ORT 1.30.0, cut elsewhere)'}: ${fixture.items.length} texts, min cosine ${min.toFixed(9)} (text ${worst}), bar ${bar}`);
if (bad) { console.error(`FAIL: ${bad} text(s) below ${bar}`); process.exit(1); }
