import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCacheDir, writeIfChanged } from '../lib/launch/launch-files.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'align-lf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('launchCacheDir', () => {
  it('uses $XDG_CACHE_HOME/align-cli/launch when set', () => {
    expect(launchCacheDir({ XDG_CACHE_HOME: '/x/cache' })).toBe(path.join('/x/cache', 'align-cli', 'launch'));
  });
  it('falls back to a per-user cache dir ending in align-cli/launch', () => {
    expect(launchCacheDir({})).toMatch(/align-cli[\\/]launch$/);
  });
});

describe('writeIfChanged', () => {
  it('writes a new file and reports it changed', () => {
    expect(writeIfChanged(dir, 'a.json', '{}')).toBe(true);
    expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{}');
  });
  it('does not rewrite identical content (mtime and inode unchanged)', () => {
    writeIfChanged(dir, 'a.json', '{}');
    const before = statSync(path.join(dir, 'a.json'));
    expect(writeIfChanged(dir, 'a.json', '{}')).toBe(false);
    const after = statSync(path.join(dir, 'a.json'));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
  it('replaces different content atomically and leaves no temp file', () => {
    writeIfChanged(dir, 'a.json', '{}');
    expect(writeIfChanged(dir, 'a.json', '{"x":1}')).toBe(true);
    expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{"x":1}');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});
