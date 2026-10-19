/**
 * A deliberately tiny ustar reader and writer, for the one archive shape we publish: plain
 * regular files, sorted, no links, no devices, no extended headers.
 *
 * Why not a library: the install-weight work exists to REMOVE dependencies, and extracting an
 * archive we built ourselves needs about sixty lines. Why so strict on read: the archive comes
 * off the network. It is hash-checked first (verified-download.ts), but a reader that would
 * follow a `../` or a symlink if the hash check were ever bypassed is one defect from writing
 * outside the cache, so anything beyond a regular file with a clean relative name throws.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

const BLOCK = 512;

export interface TarEntry {
  path: string;
  data: Uint8Array;
  /** Unix mode bits; 0o755 keeps shared libraries and the .node binding loadable. */
  mode?: number;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')  }\0`;
}

/** Byte-identical output for identical input: sorted, mtime 0, owner 0. That is what lets a
 *  digest pinned in source be re-derived by anyone, from the same upstream package. */
export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of sorted) {
    const header = Buffer.alloc(BLOCK);
    let name = e.path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      // split at a '/' so that name <= 100 and prefix <= 155
      let at = -1;
      for (let i = 0; i < name.length; i++) {
        if (name[i] === '/' && Buffer.byteLength(name.slice(i + 1)) <= 100 && Buffer.byteLength(name.slice(0, i)) <= 155) { at = i; break; }
      }
      if (at < 0) throw new Error(`tar path too long: ${e.path}`);
      prefix = name.slice(0, at);
      name = name.slice(at + 1);
    }
    header.write(name, 0, 100, 'utf8');
    header.write(octal(e.mode ?? 0o644, 8), 100, 8, 'ascii');
    header.write(octal(0, 8), 108, 8, 'ascii');
    header.write(octal(0, 8), 116, 8, 'ascii');
    header.write(octal(e.data.length, 12), 124, 12, 'ascii');
    header.write(octal(0, 12), 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii'); // checksum placeholder: eight spaces
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')  }\0 `, 148, 8, 'ascii');
    parts.push(header, Buffer.from(e.data));
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export interface ExtractLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

function cString(buf: Buffer, start: number, len: number): string {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end >= 0 && end < start + len ? end : start + len);
}

/** Parse every entry, validating all of them, BEFORE any file is written: a bad entry late in
 *  the archive must not leave the first half on disk. */
export function parseTar(buf: Buffer, limits: ExtractLimits): TarEntry[] {
  const out: TarEntry[] = [];
  let total = 0;
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) return out;
    const type = String.fromCharCode(header[156] ?? 0);
    if (type !== '0' && type !== '\0') throw new Error(`unsupported tar entry type ${JSON.stringify(type)}; only regular files are allowed`);
    const name = cString(buf, off, 100);
    const prefix = cString(buf, off + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(cString(buf, off + 124, 12).trim() || '0', 8);
    const mode = parseInt(cString(buf, off + 100, 8).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad size for ${path}`);
    const norm = normalize(path);
    if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || norm.split(sep).includes('..') || norm !== path) {
      throw new Error(`unsafe path in archive: ${JSON.stringify(path)}`);
    }
    total += size;
    if (out.length + 1 > limits.maxEntries || total > limits.maxTotalBytes) throw new Error('archive exceeds the allowed size or entry count');
    const start = off + BLOCK;
    if (start + size > buf.length) throw new Error(`truncated archive at ${path}`);
    out.push({ path, data: buf.subarray(start, start + size), mode });
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error('archive has no end marker (truncated)');
}

export function extractTar(buf: Buffer, destDir: string, limits: ExtractLimits): string[] {
  const entries = parseTar(buf, limits);
  for (const e of entries) {
    const target = join(destDir, e.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // 0o755 only when the archive says executable; the owner alone may write either way.
    writeFileSync(target, e.data, { mode: (e.mode ?? 0) & 0o111 ? 0o755 : 0o644 });
  }
  return entries.map((e) => e.path);
}
