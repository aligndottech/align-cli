/**
 * Shared low-level scan every adapter's locateSessionFiles builds on. Deliberately dumb -
 * no agent-specific knowledge here, so a bug in one adapter's cwd-matching can never be a
 * bug in this file.
 *
 * Test List:
 * 1. finds files matching the pattern, arbitrarily nested
 * 2. a root that does not exist returns [], never throws (an agent never used here)
 * 3. a pattern that matches nothing returns []
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFilesRecursive } from '../../lib/sessions/fs-scan.js';

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
