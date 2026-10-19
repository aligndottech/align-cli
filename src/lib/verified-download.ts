/**
 * Download a file and refuse it unless its SHA-256 matches a digest pinned in OUR source.
 *
 * Everything the on-device embedding path fetches goes through here (the native runtime
 * bundle, the model weights, the tokenizer). The digest, not the host, is the trust anchor:
 * GitHub, huggingface.co and any mirror a user points us at are all equally untrusted until
 * the bytes hash to the value that shipped inside this package.
 *
 * Fails closed and loud. A mismatch, a short read, an over-size body, an HTTP error and a
 * network failure each throw a `DownloadError` and return nothing, so a caller can never end
 * up holding unverified bytes. Nothing here writes to disk: persisting is the caller's job and
 * only ever happens after this returned.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export type DownloadFailure = 'network' | 'http' | 'size' | 'checksum';

export class DownloadError extends Error {
  constructor(readonly kind: DownloadFailure, message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface FetchVerifiedOptions {
  /** Lower-case hex SHA-256 of the bytes this call returns (after gunzip, when `gunzip`). */
  sha256: string;
  /** Hard cap on the returned (decompressed) size. Also bounds what a gzip bomb can expand to. */
  maxBytes: number;
  /** Treat the body as gzip and verify the DECOMPRESSED content. Digest of content, not of the
   *  compressor's output: zlib versions differ, so a digest of the .gz would not reproduce. */
  gunzip?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function readBody(url: string, maxBytes: number, timeoutMs: number, fetchImpl: typeof fetch): Promise<Buffer> {
  if (url.startsWith('file:')) {
    // Used by CI and mirrors that pre-stage the files. Same digest check applies afterwards.
    const buf = readFileSync(fileURLToPath(url));
    if (buf.length > maxBytes) throw new DownloadError('size', `${url} is ${buf.length} bytes, over the ${maxBytes} byte limit`);
    return buf;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (err) {
    throw new DownloadError('network', `could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new DownloadError('http', `${new URL(url).host} answered HTTP ${res.status} for ${url}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new DownloadError('size', `${url} declares ${declared} bytes, over the ${maxBytes} byte limit`);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (!res.body) throw new Error('empty response body');
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new DownloadError('size', `${url} sent more than the ${maxBytes} byte limit`);
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw new DownloadError('network', `connection to ${new URL(url).host} broke mid-download: ${(err as Error).message}`);
  }
  return Buffer.concat(chunks);
}

export async function fetchVerified(url: string, opts: FetchVerifiedOptions): Promise<Buffer> {
  const raw = await readBody(url, opts.maxBytes, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.fetchImpl ?? fetch);
  let content: Buffer = raw;
  if (opts.gunzip) {
    try {
      content = gunzipSync(raw, { maxOutputLength: opts.maxBytes });
    } catch (err) {
      throw new DownloadError('size', `${url} is not a valid gzip file or expands past ${opts.maxBytes} bytes: ${(err as Error).message}`);
    }
  }
  const actual = sha256Hex(content);
  if (actual !== opts.sha256.toLowerCase()) {
    throw new DownloadError('checksum', `${url} hashed to ${actual}, expected ${opts.sha256}. Refusing to use it.`);
  }
  return content;
}
