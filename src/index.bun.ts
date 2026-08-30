/**
 * Entry point for the compiled binary only (ALI-744). `scripts/build-binaries.sh` builds THIS,
 * not src/index.ts; npm still ships src/index.ts via tsc.
 *
 * It exists so the WASM embedding backend is registered before any command runs, and - more
 * importantly - so `local-embeddings-wasm.ts` is compiled ONLY by Bun. That module statically
 * imports two `.wasm`/`.mjs` assets so `--compile` embeds them, which tsc cannot emit and Node
 * cannot load. Keeping it behind this entry means the npm build never touches it.
 */
import { registerWasmEmbeddingBackend } from './lib/local-embeddings-wasm.js';

registerWasmEmbeddingBackend();

// Dynamic rather than static, so registration above happens FIRST: a static import is
// hoisted and evaluated before this module's body, which would start the CLI with no
// backend registered.
//
// Not awaited at the top level. Registration above is synchronous, so there is nothing to
// wait for - only the rejection to surface. (This also keeps the module free of top-level
// await, which `--bytecode` would reject; that flag is off for a different reason, see
// scripts/build-binaries.sh.)
import('./index.js').catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
