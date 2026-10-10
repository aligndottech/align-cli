import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastCheckFor, readLastCheck, writeLastCheck } from '../lib/curation/last-check.js';

/**
 * LM Test List (last-check.json): a check's file set and conflict ids are kept for `align mark`.
 * - The entry carries the files the diff touched and the ids of the conflicts, never the diff text.
 * - It round-trips; a missing, corrupt or wrongly shaped file reads as "no last check" (never throws).
 * - It is private (0600 where the platform has modes) and the directory is created on demand.
 * - Unwritable location: the write is silent (a check never fails over bookkeeping).
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lm-last-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('lastCheckFor', () => {
  const diff = 'diff --git a/src/b.ts b/src/b.ts\n+SECRET_LINE_OF_DIFF\ndiff --git a/src/a.ts b/src/a.ts\n+x\n';
  it('keeps the sorted files and the conflict ids, and none of the diff', () => {
    const e = lastCheckFor(diff, { conflicts: [{ decision_id: 'd1' }, { decision_id: 'd2' }] }, new Date('2026-10-10T00:00:00Z'), '/work');
    expect(e).toEqual({ checked_at: '2026-10-10T00:00:00.000Z', cwd: '/work', head: null, files: ['src/a.ts', 'src/b.ts'], decision_ids: ['d1', 'd2'] });
    expect(JSON.stringify(e)).not.toContain('SECRET_LINE_OF_DIFF');
  });
  it('prefers the file list the check itself returned, and copes with no conflicts', () => {
    const e = lastCheckFor(diff, { checked_files: ['only.ts'] }, new Date(0));
    expect(e.files).toEqual(['only.ts']);
    expect(e.decision_ids).toEqual([]);
  });
});

describe('read and write', () => {
  it('round-trips, creating the directory', () => {
    const file = path.join(dir, 'nested', 'last-check.json');
    writeLastCheck({ checked_at: 't', cwd: '/w', head: null, files: ['a.ts'], decision_ids: ['d1'] }, file);
    expect(readLastCheck(file)).toEqual({ checked_at: 't', cwd: '/w', head: null, files: ['a.ts'], decision_ids: ['d1'] });
  });
  it.skipIf(process.platform === 'win32')('is private to the user', () => {
    const file = path.join(dir, 'last-check.json');
    writeLastCheck({ checked_at: 't', cwd: '/w', head: null, files: [], decision_ids: [] }, file);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
  it('a missing, corrupt or wrongly shaped file reads as null', () => {
    const file = path.join(dir, 'last-check.json');
    expect(readLastCheck(file)).toBeNull();
    fs.writeFileSync(file, '{not json');
    expect(readLastCheck(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ files: [1, 2] }));
    expect(readLastCheck(file)).toBeNull();
  });
  it('an unwritable location is silent', () => {
    const blocker = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    expect(() => writeLastCheck({ checked_at: 't', cwd: '/w', head: null, files: [], decision_ids: [] }, path.join(blocker, 'last-check.json'))).not.toThrow();
  });
});
