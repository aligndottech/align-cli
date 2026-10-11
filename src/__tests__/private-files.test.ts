import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePrivateDir, tightenFile, tightenGraphFiles, writePrivateFile } from '../lib/private-files.js';
import { createLocalDb } from '../lib/local-db.js';
import { getLocalDbPath } from '../lib/local-mode.js';
import { assertIsolatedHome } from './helpers/isolated-home.js';
import { rmDir } from './helpers/rm-dir.js';

// Owner-only modes are a POSIX property. Windows has no mode bits (chmod only flips read-only), so these run on
// macOS and Linux; the Windows behaviour (no chmod at all) is pinned below through the injected platform check.
const posix = process.platform !== 'win32';
const mode = (p: string): number => statSync(p).mode & 0o777;

let dir: string;
let oldUmask: number | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'align-private-'));
});
afterEach(() => {
  if (oldUmask !== undefined) process.umask(oldUmask);
  oldUmask = undefined;
  rmDir(dir);
});
/** A permissive umask, so a 0600/0700 result cannot come from the umask doing the work. */
const openUmask = (): void => { oldUmask = process.umask(0o000); };

describe.skipIf(!posix)('ensurePrivateDir', () => {
  it('creates a missing directory 0700 even under umask 000', () => {
    openUmask();
    const d = path.join(dir, 'a', 'b');
    expect(ensurePrivateDir(d)).toBe(true);
    expect(mode(d)).toBe(0o700);
  });
  it('tightens an existing 0755 directory to 0700', () => {
    const d = path.join(dir, 'open');
    mkdirSync(d);
    chmodSync(d, 0o755);
    ensurePrivateDir(d);
    expect(mode(d)).toBe(0o700);
  });
  it('keeps the setgid bit while removing group and world access', () => {
    const d = path.join(dir, 'sgid');
    mkdirSync(d);
    chmodSync(d, 0o2775);
    ensurePrivateDir(d);
    expect(statSync(d).mode & 0o7777).toBe(0o2700);
  });
  it('tightens an existing 0777 directory to 0700', () => {
    const d = path.join(dir, 'world');
    mkdirSync(d);
    chmodSync(d, 0o777);
    ensurePrivateDir(d);
    expect(mode(d)).toBe(0o700);
  });
});

describe.skipIf(!posix)('tightenFile', () => {
  it('tightens a 0644 file to 0600', () => {
    const f = path.join(dir, 'f');
    writeFileSync(f, 'x');
    chmodSync(f, 0o644);
    tightenFile(f);
    expect(mode(f)).toBe(0o600);
  });
  it('tightens a 0666 file to 0600', () => {
    const f = path.join(dir, 'g');
    writeFileSync(f, 'x');
    chmodSync(f, 0o666);
    tightenFile(f);
    expect(mode(f)).toBe(0o600);
  });
  it('a missing file is not an error', () => {
    expect(() => tightenFile(path.join(dir, 'nope'))).not.toThrow();
  });
});

describe.skipIf(!posix)('writePrivateFile', () => {
  it('creates a fresh file 0600 under umask 000', () => {
    openUmask();
    const f = path.join(dir, 'fresh.json');
    writePrivateFile(f, '{}');
    expect(mode(f)).toBe(0o600);
  });
  it('rewrites a pre-existing 0644 file and leaves it 0600 (writeFileSync mode only applies on create)', () => {
    const f = path.join(dir, 'old.json');
    writeFileSync(f, 'old');
    chmodSync(f, 0o644);
    writePrivateFile(f, 'new');
    expect(mode(f)).toBe(0o600);
  });
});

describe.skipIf(!posix)('the local graph: database, -wal, -shm and its directory', () => {
  it('a fresh graph is created 0600 in a 0700 directory, whatever the umask', () => {
    openUmask();
    const dbPath = path.join(dir, 'cfg', 'align-cli', 'local.db');
    const db = createLocalDb(dbPath);
    try {
      db.insertDecision({ title: 't', summary: 's', sourceUrl: null, platform: 'cli' });
      // Positive control: WAL mode really made the sidecars, so the mode checks below are not vacuous.
      expect(statSync(`${dbPath}-wal`).isFile()).toBe(true);
      expect(statSync(`${dbPath}-shm`).isFile()).toBe(true);
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(`${dbPath}-wal`)).toBe(0o600);
      expect(mode(`${dbPath}-shm`)).toBe(0o600);
      expect(mode(path.dirname(dbPath))).toBe(0o700);
    } finally {
      db.close();
    }
  });

  it('the managed graph folder: a pre-existing 0644 graph in a 0755 folder is tightened on the next open', () => {
    const dbPath = getLocalDbPath();
    assertIsolatedHome(dbPath);
    const graphDir = path.dirname(dbPath);
    createLocalDb(dbPath).close();
    chmodSync(dbPath, 0o644);
    chmodSync(graphDir, 0o755);
    const db = createLocalDb(dbPath);
    try {
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(graphDir)).toBe(0o700);
    } finally {
      db.close();
      rmDir(graphDir);
    }
  });

  it('a graph somewhere else (a snapshot, a hand-set localDbPath): the file is tightened, its existing folder is not', () => {
    // Narrowing whatever folder the file sits in would chmod a repo or the home folder.
    const parent = path.join(dir, 'repo');
    mkdirSync(parent);
    chmodSync(parent, 0o755);
    const dbPath = path.join(parent, 'snap.db');
    createLocalDb(dbPath).close();
    chmodSync(dbPath, 0o644);
    createLocalDb(dbPath).close();
    expect(mode(dbPath)).toBe(0o600);
    expect(mode(parent)).toBe(0o755);
  });

  it('a folder that cannot be made fails with the real reason, not "unable to open database file"', () => {
    const file = path.join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(() => createLocalDb(path.join(file, 'sub', 'local.db'))).toThrow(/ENOTDIR|EEXIST/);
  });

  it('tightenGraphFiles tightens loose -wal and -shm siblings too', () => {
    const dbPath = path.join(dir, 'local.db');
    for (const s of ['', '-wal', '-shm']) { writeFileSync(`${dbPath}${s}`, ''); chmodSync(`${dbPath}${s}`, 0o644); }
    tightenGraphFiles(dbPath);
    for (const s of ['', '-wal', '-shm']) expect(mode(`${dbPath}${s}`)).toBe(0o600);
  });
});

describe('Windows: no mode bits, so nothing is chmodded (the profile folder ACL is what protects the files)', () => {
  it('ensurePrivateDir creates the directory and calls no chmod', () => {
    const calls: string[] = [];
    const d = path.join(dir, 'win');
    expect(ensurePrivateDir(d, { posix: false, chmod: (p) => { calls.push(p); } })).toBe(true);
    expect(statSync(d).isDirectory()).toBe(true);
    expect(calls).toEqual([]);
  });
  it('tightenFile calls no chmod', () => {
    const calls: string[] = [];
    const f = path.join(dir, 'f');
    writeFileSync(f, 'x');
    tightenFile(f, { posix: false, chmod: (p) => { calls.push(p); } });
    expect(calls).toEqual([]);
  });
  it('control: the same calls on POSIX do chmod', () => {
    const calls: string[] = [];
    const f = path.join(dir, 'f2');
    writeFileSync(f, 'x');
    tightenFile(f, { posix: true, chmod: (p) => { calls.push(p); }, modeOf: () => 0o644 });
    expect(calls).toEqual([f]);
  });
});
