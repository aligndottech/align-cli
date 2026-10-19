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
 *   node scripts/verify-embedding-parity.mjs [<installed @aligndottech/cli dir>]
 *
 * Downloads the runtime and model on first run (honours ALIGN_ORT_RUNTIME_URL, HF_ENDPOINT,
 * XDG_CACHE_HOME). Exits 1 on any text under the bar, 2 when nothing could be embedded.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = resolve(process.argv[2] ?? repo);
const fixture = JSON.parse(readFileSync(join(repo, "src/__tests__/fixtures/embedding-parity.json"), 'utf8'));
const { getEmbedding } = await import(pathToFileURL(join(pkg, "dist/lib/local-embeddings.js")).href);

const BAR = 0.9999;
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };

if (!fixture.items?.length) { console.error('parity fixture is empty: refusing to report a pass over nothing'); process.exit(2); }
let min = 1, worst = -1, bad = 0;
for (const [i, item] of fixture.items.entries()) {
  const got = await getEmbedding(item.text);
  if (got.length !== item.vec.length) { console.error(`text ${i}: ${got.length} dims, reference has ${item.vec.length}`); process.exit(1); }
  const c = cos(got, item.vec);
  if (c < min) { min = c; worst = i; }
  if (!(c >= BAR)) bad++;
}
console.log(`parity: ${fixture.items.length} texts, min cosine ${min.toFixed(9)} (text ${worst}), bar ${BAR}`);
if (bad) { console.error(`FAIL: ${bad} text(s) below ${BAR}`); process.exit(1); }
