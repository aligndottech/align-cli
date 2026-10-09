import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchCacheDir, writeIfChanged } from '../lib/launch/launch-files.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'align-lf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('launchCacheDir', () => {
  it('uses $XDG_CACHE_HOME/align-cli/launch when set', () => {
    expect(launchCacheDir({ XDG_CACHE_HOME: '/x/cache' })).toBe(path.join('/x/cache', 'align-cli', 'launch'));
  });
  it('ignores a relative XDG_CACHE_HOME (the XDG spec says so) and uses the default', () => {
    const dflt = launchCacheDir({});
    expect(launchCacheDir({ XDG_CACHE_HOME: 'relative/cache' })).toBe(dflt);
    expect(launchCacheDir({ XDG_CACHE_HOME: '' })).toBe(dflt);
  });
  // env-paths reads process.env.XDG_CACHE_HOME itself, so the real environment must be the
  // input here: a pure-parameter test passes while the fallback still returns the bad value.
  it('never lands in a relative dir when the REAL process env holds a relative XDG_CACHE_HOME', () => {
    vi.stubEnv('XDG_CACHE_HOME', 'relcache');
    try {
      expect(path.isAbsolute(launchCacheDir(process.env))).toBe(true);
      expect(launchCacheDir(process.env)).not.toContain('relcache');
    } finally { vi.unstubAllEnvs(); }
  });
  it('falls back to a per-user cache dir ending in align-cli/launch', () => {
    // env-paths puts the cache under a "Cache" folder on Windows (%LOCALAPPDATA%\align-cli\Cache);
    // the other platforms end in align-cli/launch directly.
    const tail = process.platform === 'win32' ? path.join('align-cli', 'Cache', 'launch') : path.join('align-cli', 'launch');
    expect(launchCacheDir({}).endsWith(path.sep + tail)).toBe(true);
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

  it.skipIf(process.platform === 'win32')('creates the launch dir with mode 0700', () => {
    const nested = path.join(dir, 'a', 'b');
    writeIfChanged(nested, 'a.json', '{}');
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });
  it.skipIf(process.platform === 'win32')('refuses a dir owned by someone else, writing nothing', () => {
    mkdirSync(path.join(dir, 'theirs'));
    const other = (process.getuid?.() ?? 0) + 1;
    expect(() => writeIfChanged(path.join(dir, 'theirs'), 'a.json', '{}', { uid: other })).toThrow(/owned by another user/);
    expect(readdirSync(path.join(dir, 'theirs'))).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('accepts a dir owned by the current user', () => {
    expect(writeIfChanged(dir, 'a.json', '{}', { uid: process.getuid?.() })).toBe(true);
  });
});

describe('writeIfChanged: nested names (C2: OPENCODE_CONFIG_DIR needs plugins/align.js under a cached dir)', () => {
  it('creates the sub-directories and writes the file', () => {
    expect(writeIfChanged(dir, 'opencode-config/plugins/align.js', 'x')).toBe(true);
    expect(readFileSync(path.join(dir, 'opencode-config', 'plugins', 'align.js'), 'utf8')).toBe('x');
  });
  it('does not rewrite identical nested content, and rewrites changed content', () => {
    writeIfChanged(dir, 'a/b.js', 'x');
    expect(writeIfChanged(dir, 'a/b.js', 'x')).toBe(false);
    expect(writeIfChanged(dir, 'a/b.js', 'y')).toBe(true);
    expect(readFileSync(path.join(dir, 'a', 'b.js'), 'utf8')).toBe('y');
  });
  it('leaves no temp file beside the nested target', () => {
    writeIfChanged(dir, 'a/b.js', 'x');
    expect(readdirSync(path.join(dir, 'a'))).toEqual(['b.js']);
  });
});
