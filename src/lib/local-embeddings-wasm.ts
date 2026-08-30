/**
 * The embedding backend for the standalone binary (ALI-744). BUN-ONLY - see the notes below
 * before moving anything in here.
 *
 * WHY THE NPM PATH DOES NOT WORK IN A BINARY
 * ------------------------------------------
 * `@huggingface/transformers`' node build imports `onnxruntime-node`. A compiled Bun binary
 * does NOT resolve bare specifiers inside files outside itself, so importing the package from
 * any on-disk location fails at ITS dependency:
 *
 *     Cannot find package 'onnxruntime-node' imported from .../transformers.node.mjs
 *
 * Measured, not assumed: the identical import succeeds under interpreted Bun and under Node,
 * and fails compiled - with a nested layout and with a flat `npm install --prefix` layout
 * alike. That is why "fetch the runtime on first use" was abandoned; there is no layout that
 * makes it resolve. (It is NOT an ABI problem: onnxruntime-node ships napi-v6 prebuilds.)
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * Uses the WEB build, whose backend is onnxruntime-web (WASM). Nothing native, nothing to
 * resolve, and the two ORT assets are embedded in the binary, so local mode needs no download
 * beyond the model it already fetches.
 *
 * Vector compatibility was the gate, and it passes: against the native backend on the same q8
 * model, cosine agreement is 1.000000000, worst per-dim delta 2.98e-08, and the pairwise
 * cosine shift retrieval actually ranks on is 2.1e-08 - five orders of magnitude inside the
 * 6.6e-04 the q8 pin exists to hold (see local-embeddings.ts). A binary and an npm install can
 * therefore share one local graph.
 */
import ortWasmPath from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm' with { type: 'file' };
import ortMjsPath from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs' with { type: 'file' };
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setEmbeddingBackend } from './local-embeddings.js';

/**
 * Where the ~23MB model is cached between runs.
 *
 * The web build has no filesystem cache at all ("File System Cache is not available in this
 * environment"), so without the custom cache below every single command would re-download it.
 */
export function modelCacheDir(): string {
  const override = process.env['ALIGN_MODEL_CACHE'];
  if (override) return override;
  if (process.platform === 'win32') {
    const base = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
    return join(base, 'align-cli', 'models');
  }
  const base = process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache');
  return join(base, 'align-cli', 'models');
}

/**
 * transformers.js asks a custom cache for a Response and hands one back to store. Keyed on the
 * request URL rather than a filename: two different repos can carry the same basename, and the
 * URL is the identity the library itself uses.
 */
function fsCache(dir: string) {
  const keyFor = (request: unknown): string => {
    const url = typeof request === 'string'
      ? request
      : (request as { url?: string }).url ?? String(request);
    return join(dir, createHash('sha256').update(url).digest('hex').slice(0, 32));
  };
  return {
    async match(request: unknown): Promise<Response | undefined> {
      const path = keyFor(request);
      return existsSync(path) ? new Response(readFileSync(path)) : undefined;
    },
    async put(request: unknown, response: Response): Promise<void> {
      mkdirSync(dir, { recursive: true });
      // clone() because the caller still needs to read the body it handed us.
      writeFileSync(keyFor(request), Buffer.from(await response.clone().arrayBuffer()));
    },
  };
}

type EmbeddingPipeline = (text: string, options: Record<string, unknown>) => Promise<Array<{ data: Float32Array }>>;

export async function createWasmEmbeddingPipeline(): Promise<EmbeddingPipeline> {
  // The WEB build still contains a STUB onnxruntime-node (`{}`) and selects it whenever
  // IS_NODE_ENV, which it computes as `process.release.name === "node"`. Bun reports "node"
  // for compatibility, so without this it picks the stub and dies with
  // `undefined is not an object (evaluating 'InferenceSession2.create')`.
  //
  // Scoped to the module's initialisation and restored immediately: the import is dynamic so
  // the check runs inside this window, and nothing else observes the value in between.
  const realName = process.release?.name;
  try { (process.release as { name: string }).name = 'bun'; } catch { /* frozen: fall through */ }
  // Named locally rather than `typeof import(...)`, which consistent-type-imports forbids.
  // Only the two members used here; the shape comes from src/types/assets.d.ts.
  let mod: {
    env: Record<string, unknown>;
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  try {
    mod = await import('../../node_modules/@huggingface/transformers/dist/transformers.web.js');
  } finally {
    try { if (realName) (process.release as { name: string }).name = realName; } catch { /* frozen */ }
  }

  const env = mod.env;
  // allowLocalModels would send it looking for a browser-relative "/models/..." path, which
  // fetch() rejects as an invalid URL before it ever tries huggingface.co.
  env['allowLocalModels'] = false;
  env['useBrowserCache'] = false;   // no Cache API here
  env['useFSCache'] = false;        // the web build has none
  env['useCustomCache'] = true;
  env['customCache'] = fsCache(modelCacheDir());

  // Through unknown: env is an untyped bag, and asserting a nested shape on it directly is a
  // cast TypeScript rightly refuses.
  const backends = env['backends'] as unknown as { onnx: { wasm: Record<string, unknown> } };
  // EXACT file paths, not a directory prefix: Bun content-hashes embedded asset names, so
  // "<dir>/ort-wasm-simd-threaded.asyncify.wasm" does not exist. Left as a prefix, ORT falls
  // back to a jsDelivr URL and a compiled binary cannot import a remote module.
  backends.onnx.wasm['wasmPaths'] = { wasm: String(ortWasmPath), mjs: String(ortMjsPath) };
  backends.onnx.wasm['numThreads'] = 1;

  // dtype q8 is load-bearing and not a size tweak - see local-embeddings.ts. The same pin has
  // to appear on both backends or the two distributions write incompatible vectors.
  return (await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'q8',
  })) as EmbeddingPipeline;
}

export function registerWasmEmbeddingBackend(): void {
  setEmbeddingBackend(createWasmEmbeddingPipeline);
}
