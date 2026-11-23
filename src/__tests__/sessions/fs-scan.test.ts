/**
 * Shared low-level scan every adapter's locateSessionFiles builds on. Deliberately dumb -
 * no agent-specific knowledge here, so a bug in one adapter's cwd-matching can never be a
 * bug in this file.
 *
 * Test List:
 * 1. finds files matching the pattern, arbitrarily nested
 * 2. a root that does not exist returns [], never throws (an agent never used here)
 * 3. a pattern that matches nothing returns []
 * 4. readLines yields every line, with or without a trailing newline, and nothing for an empty file
 * 5. readLines joins a line longer than one read, and never splits a multi-byte character
 * 6. readLines closes the file when the caller stops early (it is deletable on any OS afterwards)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFilesRecursive, readLines } from '../../lib/sessions/fs-scan.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'align-fs-scan-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('findFilesRecursive', () => {
  it('finds matching files nested several directories deep', () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'one.jsonl'), '{}');
    writeFileSync(join(root, 'a', 'two.jsonl'), '{}');
    const found = findFilesRecursive(root, /\.jsonl$/);
    expect(found.sort()).toEqual([join(root, 'a', 'b', 'one.jsonl'), join(root, 'a', 'two.jsonl')].sort());
  });

  it('a root that does not exist returns an empty array rather than throwing', () => {
    expect(findFilesRecursive(join(root, 'never-created'), /\.jsonl$/)).toEqual([]);
  });

  it('ignores files that do not match the pattern', () => {
    writeFileSync(join(root, 'notes.txt'), 'hi');
    expect(findFilesRecursive(root, /\.jsonl$/)).toEqual([]);
  });
});

describe('readLines', () => {
  const write = (content: string): string => {
    const file = join(root, 'lines.jsonl');
    writeFileSync(file, content);
    return file;
  };

  it('yields every line, whether or not the last one ends in a newline', () => {
    expect([...readLines(write('one\ntwo\n'))]).toEqual(['one', 'two']);
    expect([...readLines(write('one\ntwo'))]).toEqual(['one', 'two']);
    expect([...readLines(write('one\n\ntwo\n'))]).toEqual(['one', '', 'two']);
  });

  it('yields nothing for an empty file', () => {
    expect([...readLines(write(''))]).toEqual([]);
  });

  it('joins a line longer than one read, without splitting a multi-byte character across reads', () => {
    // Three bytes per character, so some character straddles every read boundary whatever the
    // chunk size is, and 200,000 of them is several reads at any plausible one.
    const long = '\u20ac'.repeat(200_000);
    expect([...readLines(write(`${long}\nafter\n`))]).toEqual([long, 'after']);
  });

  it('closes the file when the caller stops at the first line', () => {
    const file = write('first\nsecond\n');
    for (const line of readLines(file)) {
      expect(line).toBe('first');
      break;
    }
    // Windows refuses to delete a file that is still open; POSIX would not notice a leak here.
    expect(() => rmSync(file)).not.toThrow();
  });
});
