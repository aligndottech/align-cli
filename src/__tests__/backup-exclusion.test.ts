import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BackupDeps, CACHEDIR_TAG_SIGNATURE, excludeGraphFromBackups } from '../lib/backup-exclusion.js';
import { rmDir } from './helpers/rm-dir.js';
import { assertIsolatedHome } from './helpers/isolated-home.js';
import { getLocalDbPath, initLocalMode } from '../lib/local-mode.js';

let dir: string;
let dbPath: string;
let runs: Array<{ cmd: string; args: string[] }>;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'align-backup-'));
  dbPath = path.join(dir, 'local.db');
  writeFileSync(dbPath, '');
  runs = [];
});
afterEach(() => rmDir(dir));

/** Real file system for the marker, injected platform and process runner (never the real tmutil). */
const deps = (over: Partial<BackupDeps> = {}): BackupDeps => ({
  platform: 'darwin',
  hasTmutil: () => true,
  run: (cmd, args) => { runs.push({ cmd, args }); },
  ...over,
});
const tag = (): string => path.join(dir, 'CACHEDIR.TAG');

describe('excluding the local graph directory from backups', () => {
  it('macOS with tmutil: adds a Time Machine exclusion for the graph directory and writes CACHEDIR.TAG', () => {
    excludeGraphFromBackups(dbPath, deps());
    expect(runs).toEqual([{ cmd: '/usr/bin/tmutil', args: ['addexclusion', dir] }]);
    expect(readFileSync(tag(), 'utf8').startsWith(CACHEDIR_TAG_SIGNATURE)).toBe(true);
  });

  it('macOS without tmutil: no command runs, the tag is still written', () => {
    excludeGraphFromBackups(dbPath, deps({ hasTmutil: () => false }));
    expect(runs).toEqual([]);
    expect(existsSync(tag())).toBe(true);
  });

  it('Linux: never runs tmutil, writes the tag', () => {
    excludeGraphFromBackups(dbPath, deps({ platform: 'linux' }));
    expect(runs).toEqual([]);
    expect(existsSync(tag())).toBe(true);
  });

  it('Windows: never runs tmutil, writes the tag', () => {
    excludeGraphFromBackups(dbPath, deps({ platform: 'win32' }));
    expect(runs).toEqual([]);
    expect(existsSync(tag())).toBe(true);
  });

  it('runs once: an existing tag means it was done, so tmutil is not run again', () => {
    excludeGraphFromBackups(dbPath, deps());
    excludeGraphFromBackups(dbPath, deps());
    expect(runs.length).toBe(1);
  });

  it('the documented undo sticks: after the person deletes CACHEDIR.TAG, neither the tag nor the exclusion comes back', () => {
    excludeGraphFromBackups(dbPath, deps());
    rmSync(tag());
    excludeGraphFromBackups(dbPath, deps());
    expect(runs.length).toBe(1);
    expect(existsSync(tag())).toBe(false);
  });

  it('never fatal: a tmutil that throws still leaves the tag and does not throw', () => {
    expect(() => excludeGraphFromBackups(dbPath, deps({ run: () => { throw new Error('tmutil: permission denied'); } }))).not.toThrow();
    expect(existsSync(tag())).toBe(true);
  });

  it('never fatal: a tag that cannot be written does not throw, and the exclusion still ran', () => {
    expect(() => excludeGraphFromBackups(dbPath, deps({ writeFile: () => { throw new Error('EROFS'); } }))).not.toThrow();
    expect(runs.length).toBe(1);
  });

  it('does nothing until a local graph exists (a cloud-only user keeps their config dir as it is)', () => {
    excludeGraphFromBackups(path.join(dir, 'other.db'), deps());
    expect(runs).toEqual([]);
    expect(existsSync(tag())).toBe(false);
  });

  it('the tag carries the exact signature the Cache Directory Tagging spec requires', () => {
    // https://bford.info/cachedir/ - tools match these 43 bytes exactly.
    expect(CACHEDIR_TAG_SIGNATURE).toBe('Signature: 8a477f597d28d172789f06886806bc55');
  });
});

describe('wired: align setup --local / align local start mark the graph directory', () => {
  it('initLocalMode excludes the new graph directory, through the injected runner', async () => {
    const graph = getLocalDbPath();
    assertIsolatedHome(graph);
    await initLocalMode({ backupDeps: deps() });
    expect(runs).toEqual([{ cmd: '/usr/bin/tmutil', args: ['addexclusion', path.dirname(graph)] }]);
    expect(existsSync(path.join(path.dirname(graph), 'CACHEDIR.TAG'))).toBe(true);
  });
});
