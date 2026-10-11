/**
 * The on-disk cache transformers.js reads the embedding model through (local-embeddings-wasm.ts,
 * the binary build). A module of its own so it can be tested without loading the wasm runtime.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, writePrivateFile } from './private-files.js';

/**
 * transformers.js asks a custom cache for a Response and hands one back to store. Keyed on the
 * request URL rather than a filename: two different repos can carry the same basename, and the
 * URL is the identity the library itself uses.
 */
export function modelFileCache(dir: string) {
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
      // Owner-only like everything else align keeps (private-files.ts), and tightened when an older
      // version left the directory wider.
      ensurePrivateDir(dir);
      // clone() because the caller still needs to read the body it handed us.
      writePrivateFile(keyFor(request), Buffer.from(await response.clone().arrayBuffer()));
    },
  };
}
