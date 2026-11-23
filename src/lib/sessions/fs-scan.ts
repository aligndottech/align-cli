import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every file under `root` (recursively) whose full path matches `pattern`. A missing or
 * unreadable root is "this agent has never run here" - the normal case, not an error - so
 * it returns [] rather than throwing. Every adapter's locateSessionFiles builds on this.
 */
export function findFilesRecursive(root: string, pattern: RegExp): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFilesRecursive(full, pattern));
    } else if (pattern.test(full)) {
      found.push(full);
    }
  }
  return found;
}

const FIRST_READ_BYTES = 4 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * A file's lines, read lazily, so a caller that only needs the opening lines stops paying there.
 * Locating sessions is that caller: an adapter learns a transcript's project from its first line
 * or two, and reading every transcript whole to learn it meant reading the entire session store.
 *
 * The first read is one 4KB page, because that is where the answer almost always is (the longest
 * pi header across 1,816 real sessions is 353 bytes). Each read after it doubles, up to 64KB, so
 * a file that does need more is not read a page at a time.
 *
 * Bytes are decoded a whole line at a time, never a read at a time, so a multi-byte character
 * that straddles two reads cannot be split. A line longer than a read is held until its newline
 * arrives - memory is bounded by the longest line actually consumed, not by the file.
 */
export function* readLines(filePath: string): Generator<string> {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_READ_BYTES);
    let readBytes = FIRST_READ_BYTES;
    let partial: Buffer[] = [];
    for (;;) {
      const read = readSync(fd, buffer, 0, readBytes, null);
      if (read === 0) break;
      readBytes = Math.min(readBytes * 2, MAX_READ_BYTES);
      const bytes = buffer.subarray(0, read);
      let lineStart = 0;
      for (let nl = bytes.indexOf(NEWLINE); nl !== -1; nl = bytes.indexOf(NEWLINE, lineStart)) {
        yield Buffer.concat([...partial, bytes.subarray(lineStart, nl)]).toString('utf8');
        partial = [];
        lineStart = nl + 1;
      }
      // Copied, because the next read overwrites the buffer this slice points into.
      if (lineStart < read) partial.push(Buffer.from(bytes.subarray(lineStart)));
    }
    if (partial.length > 0) yield Buffer.concat(partial).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The line pi and codex put a session's cwd on: the first one that is not blank. */
export function firstNonBlankLine(filePath: string): string | null {
  for (const line of readLines(filePath)) {
    if (line.trim()) return line;
  }
  return null;
}

/** Newest-first by mtime - agent-agnostic, so it works whether or not a format's own
 *  embedded timestamp was parseable. */
export function sortByMtimeDesc(files: string[]): string[] {
  return [...files].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
