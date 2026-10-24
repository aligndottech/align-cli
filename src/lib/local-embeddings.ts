import { alignDistribution } from './distribution.js';
import { embeddingLengthMismatch } from './similarity/embedding-matrix.js';

/**
 * The HF model id and dtype every distribution embeds with. Single source of truth: the
 * default loader below AND the WASM backend (local-embeddings-wasm.ts) both read these
 * instead of each hardcoding the same two literals a second time - the same "two writers
 * of one fact" shape code-style.md documents for an enum and a DB constraint, here for a
 * model id and a schema tag. local-db.ts's `decision_embeddings.model` column is stamped
 * from this constant by the one production caller (local-gateway-client.ts), so a future
 * model change is one line here plus a migration, not a hunt across three files.
 *
 * An evaluation of bge-small-en-v1.5 as a replacement did NOT adopt it - see
 * docs/embedding-model-evaluation.md for the measured numbers and why.
 */
export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DTYPE = 'q8';

type EmbeddingPipeline = (text: string, options: Record<string, unknown>) => Promise<Array<{ data: Float32Array }>>;
let _pipe: EmbeddingPipeline | null = null;

/**
 * A backend that produces the pipeline, injected at the entry point.
 *
 * The standalone binary cannot use the default loader below: `@huggingface/transformers`
 * resolves `onnxruntime-node`, and a compiled binary does not resolve bare specifiers for
 * files outside itself - measured, and true whatever the on-disk layout. So the
 * binary registers a WASM backend instead, from `src/index.bun.ts`.
 *
 * Injected rather than branched on `alignDistribution()` here, because the WASM module has
 * to statically import two ORT assets so `bun build --compile` embeds them - and a static
 * import of a `.wasm` is neither typecheckable by tsc nor loadable by Node. Keeping it
 * behind a registration hook means npm's build never compiles or ships that file at all.
 */
export type EmbeddingBackend = () => Promise<EmbeddingPipeline>;
let _backend: EmbeddingBackend | null = null;

export function setEmbeddingBackend(backend: EmbeddingBackend): void {
  _backend = backend;
  _pipe = null;
  _loading = null; // a backend swapped after first use must not keep serving the old pipeline
}

/** Test seam. Not for production paths - the binary registers exactly once, at startup. */
export function resetEmbeddingBackend(): void {
  _backend = null;
  _pipe = null;
  _loading = null;
}

let _loading: Promise<EmbeddingPipeline> | null = null;

/** One setup in flight at a time: concurrent first calls (ingest runs several) must share one
 *  download and one ORT session, not each start their own. A failure is not remembered. */
async function pipeline(): Promise<EmbeddingPipeline> {
  if (_pipe) return _pipe;
  _loading ??= setupPipeline().then((p) => { _pipe = p; return p; }).finally(() => { _loading = null; });
  return _loading;
}

export async function getEmbedding(text: string): Promise<Float32Array> {
  const pipe = await pipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return output[0]!.data;
}

async function setupPipeline(): Promise<EmbeddingPipeline> {
  let built: EmbeddingPipeline | null = null;
  if (!built && _backend) {
    try {
      built = await _backend();
    } catch (err) {
      // Wrapped, because an unwrapped failure here reaches the user as a raw ORT or fetch
      // error. The overwhelmingly likely cause is the one-time model download, so say that.
      throw new Error(
        'Could not start the on-device embedding model (~23MB, Xenova/all-MiniLM-L6-v2, ' +
        'downloaded once from huggingface.co and then cached). Check your internet ' +
        `connection or proxy and try again. (${(err as Error).message})`,
      );
    }
  }
  if (!built) {
    if (alignDistribution() === 'binary') {
      // The binary registers its bundled WASM backend at startup (index.bun.ts). Reaching this
      // line means that registration did not happen: a build defect, and the npm advice
      // ("reinstall on a supported platform") is unfollowable for someone with no package.
      throw new Error(
        'Local mode needs the on-device embedding model, and the standalone binary did not register its bundled WASM backend. ' +
        'That is a build defect rather than a limit of your machine - please report it. Cloud mode (`align login`) works meanwhile.',
      );
    }
    // Dynamic: the tokenizer and runtime loader stay off the launch path of every command that
    // never embeds (and `align --version`, the hook's stdin parse, ...).
    const { EmbeddingAssetsMissing } = await import('./embedding-runtime.js');
    try {
      const { createNativeEmbeddingPipeline } = await import('./local-embeddings-native.js');
      // The npm package no longer depends on @huggingface/transformers. The native
      // runtime for this os/arch and the model files are fetched once, digest-checked, into the
      // user cache dir (embedding-runtime.ts), then everything runs offline.
      built = await createNativeEmbeddingPipeline();
    } catch (err) {
      if (err instanceof EmbeddingAssetsMissing) {
        throw new Error(
          err.reason === 'unsupported-platform'
            ? `Local mode needs the on-device embedding runtime, which is not available on this platform. Use cloud mode (\`align login\`), or reinstall on a supported platform (macOS arm64, glibc Linux, or Windows x64/arm64). (${err.message})`
            : err.message,
        );
      }
      // Wrapped, because an unwrapped failure here reaches the user as a raw fetch or dlopen
      // error. The common cause is the one-time download, so say that and where it came from.
      throw new Error(
        'Could not set up the on-device embedding model (~23MB model, ~20MB runtime, downloaded once from ' +
        'github.com and huggingface.co, then cached). Check your internet connection or proxy and try again. ' +
        `Cloud mode (\`align login\`) works meanwhile. (${(err as Error).message})`,
      );
    }
  }
  return built!;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Loudly, because the silent version is worse than a crash: this loop indexes `b[i]` over
  // `a.length`, so a shorter `b` yields undefined -> NaN -> `NaN >= threshold` is false, and
  // findSimilar drops the row as IRRELEVANT. A vector written by a different model would make
  // decisions quietly unfindable with no error anywhere.
  if (a.length !== b.length) {
    throw embeddingLengthMismatch(a.length, b.length);
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
