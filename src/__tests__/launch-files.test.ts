import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchCacheDir, pruneLaunchFiles, writeIfChanged } from '../lib/launch/launch-files.js';

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

describe('writeIfChanged: a file with a mode (review F3: the Gemini system copy is 0600)', () => {
  it.skipIf(process.platform === 'win32')('writes it with that mode, whatever the umask', () => {
    const old = process.umask(0o022);
    try {
      writeIfChanged(dir, 'copy.json', '{}', { mode: 0o600 });
      expect(statSync(path.join(dir, 'copy.json')).mode & 0o777).toBe(0o600);
      writeIfChanged(dir, 'copy.json', '{"b":2}', { mode: 0o600 });
      expect(statSync(path.join(dir, 'copy.json')).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });
  it.skipIf(process.platform === 'win32')('tightens an existing looser file even when the content is unchanged', () => {
    writeFileSync(path.join(dir, 'copy.json'), '{}', { mode: 0o644 });
    chmodSync(path.join(dir, 'copy.json'), 0o644);
    expect(writeIfChanged(dir, 'copy.json', '{}', { mode: 0o600 })).toBe(false);
    expect(statSync(path.join(dir, 'copy.json')).mode & 0o777).toBe(0o600);
  });
  it.skipIf(process.platform === 'win32')('a temp file left by a crashed launch does not block the write', () => {
    writeFileSync(path.join(dir, `.copy.json.${process.pid}.tmp`), 'stale');
    expect(writeIfChanged(dir, 'copy.json', '{"a":1}', { mode: 0o600 })).toBe(true);
    expect(readFileSync(path.join(dir, 'copy.json'), 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(['copy.json']);
  });
  it.skipIf(process.platform === 'win32')('tightens an existing launch dir the user owns to 0700', () => {
    const loose = path.join(dir, 'loose');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    writeIfChanged(loose, 'a.json', '{}');
    expect(statSync(loose).mode & 0o777).toBe(0o700);
  });
});

describe('writeIfChanged: never writes through a link someone planted (review: prove wx, not just the mode)', () => {
  let victimDir: string;
  beforeEach(() => { victimDir = mkdtempSync(path.join(os.tmpdir(), 'align-victim-')); });
  afterEach(() => { rmSync(victimDir, { recursive: true, force: true }); });
  const victim = () => path.join(victimDir, 'victim.txt');

  it.skipIf(process.platform === 'win32').each([['with a mode', { mode: 0o600 }], ['without a mode', {}]] as const)(
    'a symlink at the temp path (%s) is not followed: the victim is untouched and the file is a regular file',
    (_l, opts) => {
      writeFileSync(victim(), 'secret');
      symlinkSync(victim(), path.join(dir, `.copy.json.${process.pid}.tmp`));
      expect(writeIfChanged(dir, 'copy.json', '{"a":1}', opts)).toBe(true);
      expect(readFileSync(victim(), 'utf8')).toBe('secret');
      expect(lstatSync(path.join(dir, 'copy.json')).isSymbolicLink()).toBe(false);
      expect(readFileSync(path.join(dir, 'copy.json'), 'utf8')).toBe('{"a":1}');
    },
  );

  it.skipIf(process.platform === 'win32')('a symlink at the target name is replaced by a real file, even when the victim already holds our content', () => {
    writeFileSync(victim(), '{"a":1}');
    symlinkSync(victim(), path.join(dir, 'copy.json'));
    expect(writeIfChanged(dir, 'copy.json', '{"a":1}', { mode: 0o600 })).toBe(true);
    expect(lstatSync(path.join(dir, 'copy.json')).isSymbolicLink()).toBe(false);
    expect(statSync(path.join(dir, 'copy.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(victim(), 'utf8')).toBe('{"a":1}');
  });
});

describe('pruneLaunchFiles (a concurrent session\'s live copy survives)', () => {
  const HOUR = 3600_000;
  const now = Date.now();
  const age = (n: string, ms: number) => utimesSync(path.join(dir, n), new Date(now - ms), new Date(now - ms));
  const names = () => readdirSync(dir).sort();

  it('a launch for B leaves a fresh copy A alone (another session may be reading it)', () => {
    for (const n of ['g-A.json', 'g-B.json']) writeIfChanged(dir, n, '{}');
    pruneLaunchFiles(dir, 'g-', { keep: 'g-B.json', now });
    expect(names()).toEqual(['g-A.json', 'g-B.json']);
  });
  it('a copy older than 24 hours is removed; one just under 24 hours is not', () => {
    for (const n of ['g-A.json', 'g-B.json', 'g-C.json']) writeIfChanged(dir, n, '{}');
    age('g-A.json', 25 * HOUR);
    age('g-C.json', 23 * HOUR);
    pruneLaunchFiles(dir, 'g-', { keep: 'g-B.json', now });
    expect(names()).toEqual(['g-B.json', 'g-C.json']);
  });
  it('a launch for B that does not inject removes B, and a fresh A survives', () => {
    for (const n of ['g-A.json', 'g-B.json']) writeIfChanged(dir, n, '{}');
    pruneLaunchFiles(dir, 'g-', { remove: 'g-B.json', now });
    expect(names()).toEqual(['g-A.json']);
  });
  it('the copy in use has its mtime refreshed, so an old but live copy is not aged out later', () => {
    writeIfChanged(dir, 'g-B.json', '{}');
    age('g-B.json', 30 * HOUR);
    pruneLaunchFiles(dir, 'g-', { keep: 'g-B.json', now });
    expect(names()).toEqual(['g-B.json']);
    expect(Math.abs(statSync(path.join(dir, 'g-B.json')).mtimeMs - now)).toBeLessThan(2000);
  });
  it('files without the prefix are never touched, however old; a missing dir is fine', () => {
    writeIfChanged(dir, 'claude-mcp.json', '{}');
    age('claude-mcp.json', 100 * HOUR);
    pruneLaunchFiles(dir, 'g-', { now });
    expect(names()).toEqual(['claude-mcp.json']);
    expect(() => pruneLaunchFiles(path.join(dir, 'nope'), 'g-', { now })).not.toThrow();
  });
});
