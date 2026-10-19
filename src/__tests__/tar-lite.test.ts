import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTar, parseTar, writeTar } from '../lib/tar-lite.js';

const limits = { maxEntries: 100, maxTotalBytes: 10_000_000 };
function refreshChecksum(tar: Buffer): void {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : tar[i]!;
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}
const LONG = `node_modules/onnxruntime-common/dist/cjs/${'sub/'.repeat(10)}index-with-a-rather-long-name.js`;

describe('tar-lite', () => {
  it('round-trips files, long paths and modes', () => {
    const tar = writeTar([
      { path: 'b.txt', data: Buffer.from('bee') },
      { path: 'bin/x.node', data: Buffer.from('native'), mode: 0o755 },
      { path: LONG, data: Buffer.from('long') },
    ]);
    const entries = parseTar(tar, limits);
    expect(entries.map((e) => e.path)).toEqual([LONG, 'b.txt', 'bin/x.node'].sort());
    expect(Buffer.from(entries.find((e) => e.path === LONG)!.data).toString()).toBe('long');
  });

  it('is byte-for-byte reproducible regardless of input order', () => {
    const a = writeTar([{ path: 'a', data: Buffer.from('1') }, { path: 'b', data: Buffer.from('2') }]);
    const b = writeTar([{ path: 'b', data: Buffer.from('2') }, { path: 'a', data: Buffer.from('1') }]);
    expect(a.equals(b)).toBe(true);
  });

  it('extracts to disk, keeping the executable bit only where the archive had it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    extractTar(writeTar([{ path: 'd/a.txt', data: Buffer.from('A') }, { path: 'd/lib.so', data: Buffer.from('L'), mode: 0o755 }]), dir, limits);
    expect(readFileSync(join(dir, 'd/a.txt'), 'utf8')).toBe('A');
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'd/lib.so')).mode & 0o111).not.toBe(0);
      expect(statSync(join(dir, 'd/a.txt')).mode & 0o111).toBe(0);
    }
  });

  it.each(['../evil.txt', '/abs/evil.txt', 'a/../../evil.txt', 'a\\b.txt', 'C:evil.txt', 'a.txt:stream'])('rejects the unsafe path %s and writes nothing', (p) => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    const tar = writeTar([{ path: 'ok.txt', data: Buffer.from('ok') }, { path: p, data: Buffer.from('x') }]);
    expect(() => extractTar(tar, dir, limits)).toThrow(/unsafe path/);
    expect(existsSync(join(dir, 'ok.txt'))).toBe(false); // validated whole archive before writing any of it
  });

  it('rejects links and other non-regular entries', () => {
    const tar = writeTar([{ path: 'l', data: Buffer.from('') }]);
    tar[156] = '2'.charCodeAt(0); // symlink
    refreshChecksum(tar);
    expect(() => parseTar(tar, limits)).toThrow(/unsupported tar entry type/);
  });

  it('enforces the entry and byte caps', () => {
    const tar = writeTar([{ path: 'a', data: Buffer.alloc(600) }, { path: 'b', data: Buffer.alloc(600) }]);
    expect(() => parseTar(tar, { maxEntries: 1, maxTotalBytes: 10_000 })).toThrow(/exceeds/);
    expect(() => parseTar(tar, { maxEntries: 5, maxTotalBytes: 1000 })).toThrow(/exceeds/);
  });

  it('rejects a header whose checksum does not match (a corrupted or hand-edited archive)', () => {
    const tar = writeTar([{ path: 'a', data: Buffer.from('x') }]);
    tar[0] = 'b'.charCodeAt(0); // rename the entry without fixing the checksum
    expect(() => parseTar(tar, limits)).toThrow(/checksum/);
  });

  it('rejects a truncated archive', () => {
    const tar = writeTar([{ path: 'a', data: Buffer.alloc(2000) }]);
    expect(() => parseTar(tar.subarray(0, 1000), limits)).toThrow(/truncated/);
  });
});
