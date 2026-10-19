import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DownloadError, fetchVerified } from '../lib/verified-download.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const serve = (handler: (path: string) => { status?: number; body: Buffer }) =>
  new Promise<{ url: string; close: () => void }>((resolve) => {
    const s = createServer((req, res) => {
      const r = handler(req.url ?? '/');
      res.statusCode = r.status ?? 200;
      res.end(r.body);
    }).listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });

describe('fetchVerified', () => {
  it('returns the bytes when they hash to the pinned digest', async () => {
    const body = Buffer.from('runtime bytes');
    const srv = await serve(() => ({ body }));
    try {
      const got = await fetchVerified(`${srv.url}/a`, { sha256: sha(body), maxBytes: 1000 });
      expect(got.equals(body)).toBe(true);
    } finally { srv.close(); }
  });

  it('refuses a tampered download: throws a checksum error and returns nothing', async () => {
    const good = Buffer.from('the pinned bytes');
    const srv = await serve(() => ({ body: Buffer.from('the pinned byteS') }));
    try {
      const err = await fetchVerified(`${srv.url}/a`, { sha256: sha(good), maxBytes: 1000 }).catch((e) => e);
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).kind).toBe('checksum');
      expect(String(err.message)).toMatch(/Refusing to use it/);
    } finally { srv.close(); }
  });

  it('verifies the DECOMPRESSED content of a gzip body, not the compressed bytes', async () => {
    const content = Buffer.from('x'.repeat(5000));
    const srv = await serve(() => ({ body: gzipSync(content) }));
    try {
      const got = await fetchVerified(`${srv.url}/a`, { sha256: sha(content), maxBytes: 10_000, gunzip: true });
      expect(got.equals(content)).toBe(true);
      const bad = await fetchVerified(`${srv.url}/a`, { sha256: sha(gzipSync(content)), maxBytes: 10_000, gunzip: true }).catch((e) => e);
      expect((bad as DownloadError).kind).toBe('checksum');
    } finally { srv.close(); }
  });

  it('refuses a gzip bomb that expands past the cap', async () => {
    const srv = await serve(() => ({ body: gzipSync(Buffer.alloc(200_000)) }));
    try {
      const err = await fetchVerified(`${srv.url}/a`, { sha256: '0'.repeat(64), maxBytes: 10_000, gunzip: true }).catch((e) => e);
      expect((err as DownloadError).kind).toBe('size');
    } finally { srv.close(); }
  });

  it('refuses a body over the size cap without buffering all of it', async () => {
    const srv = await serve(() => ({ body: Buffer.alloc(5000) }));
    try {
      const err = await fetchVerified(`${srv.url}/a`, { sha256: '0'.repeat(64), maxBytes: 1000 }).catch((e) => e);
      expect((err as DownloadError).kind).toBe('size');
    } finally { srv.close(); }
  });

  it('turns an HTTP error into a clear failure naming the host and status', async () => {
    const srv = await serve(() => ({ status: 404, body: Buffer.from('nope') }));
    try {
      const err = await fetchVerified(`${srv.url}/a`, { sha256: '0'.repeat(64), maxBytes: 1000 }).catch((e) => e);
      expect((err as DownloadError).kind).toBe('http');
      expect(String(err.message)).toMatch(/HTTP 404/);
    } finally { srv.close(); }
  });

  it('fails fast and clearly with no network (connection refused), instead of hanging', async () => {
    const srv = await serve(() => ({ body: Buffer.alloc(0) }));
    const url = srv.url;
    srv.close();
    const t0 = Date.now();
    const err = await fetchVerified(`${url}/a`, { sha256: '0'.repeat(64), maxBytes: 1000, timeoutMs: 5000 }).catch((e) => e);
    expect((err as DownloadError).kind).toBe('network');
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('times out a server that never answers', async () => {
    const hang = createServer(() => { /* never respond */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const port = (hang.address() as { port: number }).port;
    try {
      const err = await fetchVerified(`http://127.0.0.1:${port}/a`, { sha256: '0'.repeat(64), maxBytes: 1000, timeoutMs: 300 }).catch((e) => e);
      expect((err as DownloadError).kind).toBe('network');
    } finally { hang.closeAllConnections(); hang.close(); }
  });

  it('reads file: URLs (pre-staged mirrors, CI) through the same digest check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vd-'));
    const f = join(dir, 'a.bin');
    writeFileSync(f, 'staged');
    const url = pathToFileURL(f).href;
    expect((await fetchVerified(url, { sha256: sha(Buffer.from('staged')), maxBytes: 100 })).toString()).toBe('staged');
    const err = await fetchVerified(url, { sha256: '0'.repeat(64), maxBytes: 100 }).catch((e) => e);
    expect((err as DownloadError).kind).toBe('checksum');
  });
});
