/**
 * The on-disk cache transformers.js reads the embedding model through (local-embeddings-wasm.ts,
 * the binary build). A module of its own so it can be tested without loading the wasm runtime.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

/**
 * Where everything the on-device embedding path caches lives: the model files and the native
 * runtime, for the npm install and the standalone binary alike (one directory to warm in CI,
 * one to delete to start clean).
 *
 * Never inside the install tree. transformers.js defaulted to `node_modules/@huggingface/
 * transformers/.cache`, which is read-only for a root-owned global prefix (`sudo npm i -g`),
 * is wiped by every upgrade, and ignored XDG_CACHE_HOME.
 *
 * `ALIGN_MODEL_CACHE` overrides all of it. Otherwise XDG_CACHE_HOME (or ~/.cache), and
 * %LOCALAPPDATA% on Windows.
 */
export function modelCacheDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform, home: string = homedir()): string {
  const override = env['ALIGN_MODEL_CACHE'];
  if (override) return override;
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'] || join(home, 'AppData', 'Local');
    return join(base, 'align-cli', 'models');
  }
  const base = env['XDG_CACHE_HOME'] || join(home, '.cache');
  return join(base, 'align-cli', 'models');
}
