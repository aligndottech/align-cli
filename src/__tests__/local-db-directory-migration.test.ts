import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { legacyLocalDbDir, migrateLocalDb } from '../lib/local-mode.js';

/**
 * Copilot review on #231: getLocalDbPath() switching to env-paths means anyone with a
 * non-default XDG_CONFIG_HOME - or, on a fresh install of THIS fix, simply anyone
 * upgrading - has their existing local.db sitting at the old hand-rolled path
 * (~/.config/align-cli, computed without reading XDG_CONFIG_HOME) while the new code
 * looks in env-paths' directory. Without a migration their local graph appears to
 * vanish. Same shape as migrateConfigDirectory in config.ts, applied to the DB file
 * and its WAL/SHM sidecars (local-db.test.ts's own cleanup code already treats those
 * three suffixes as one unit: '', '-wal', '-shm').
 */
describe('migrateLocalDb', () => {
  const dirs: string[] = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'align-db-migrate-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('copies local.db and its WAL/SHM sidecars to the new location', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'local.db'), 'main-db-bytes');
    fs.writeFileSync(path.join(oldDir, 'local.db-wal'), 'wal-bytes');
    fs.writeFileSync(path.join(oldDir, 'local.db-shm'), 'shm-bytes');

    migrateLocalDb(oldDir, newDir);

    expect(fs.readFileSync(path.join(newDir, 'local.db'), 'utf8')).toBe('main-db-bytes');
    expect(fs.readFileSync(path.join(newDir, 'local.db-wal'), 'utf8')).toBe('wal-bytes');
    expect(fs.readFileSync(path.join(newDir, 'local.db-shm'), 'utf8')).toBe('shm-bytes');
  });

  it('copies local.db fine when there are no WAL/SHM sidecars to begin with', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'local.db'), 'main-db-bytes');

    expect(() => migrateLocalDb(oldDir, newDir)).not.toThrow();
    expect(fs.readFileSync(path.join(newDir, 'local.db'), 'utf8')).toBe('main-db-bytes');
    expect(fs.existsSync(path.join(newDir, 'local.db-wal'))).toBe(false);
  });

  it('leaves the old files in place after copying', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'local.db'), 'main-db-bytes');

    migrateLocalDb(oldDir, newDir);

    expect(fs.existsSync(path.join(oldDir, 'local.db'))).toBe(true);
  });

  it('never overwrites a local.db that already exists at the new location', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'local.db'), 'stale-old-bytes');
    fs.writeFileSync(path.join(newDir, 'local.db'), 'the-real-current-graph');

    migrateLocalDb(oldDir, newDir);

    expect(fs.readFileSync(path.join(newDir, 'local.db'), 'utf8')).toBe('the-real-current-graph');
  });

  it('does nothing when neither directory has a local.db', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();

    expect(() => migrateLocalDb(oldDir, newDir)).not.toThrow();
    expect(fs.existsSync(path.join(newDir, 'local.db'))).toBe(false);
  });

  it('does nothing when the old directory was never created (a genuinely fresh machine)', () => {
    const oldDir = path.join(os.tmpdir(), `align-db-migrate-never-created-${Math.random()}`);
    const newDir = mkTmp();

    expect(() => migrateLocalDb(oldDir, newDir)).not.toThrow();
    expect(fs.existsSync(path.join(newDir, 'local.db'))).toBe(false);
  });

  // Worse than overwriting the DB, and a separate branch from the case above: a `-wal`
  // holds committed frames belonging to the database it was written for. Copying one
  // across onto a DIFFERENT database is how SQLite gets handed another file's
  // transactions. All three files move together or none do.
  it('copies no sidecar either when the new location already has a local.db', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'local.db'), 'stale-legacy-graph');
    fs.writeFileSync(path.join(oldDir, 'local.db-wal'), 'frames-for-a-different-database');
    fs.writeFileSync(path.join(newDir, 'local.db'), 'the-real-current-graph');

    migrateLocalDb(oldDir, newDir);

    expect(fs.existsSync(path.join(newDir, 'local.db-wal'))).toBe(false);
  });

  // macOS and default Linux - i.e. most machines - resolve both directories to the same
  // path, so the migration must decline rather than copy the graph onto itself.
  //
  // Asserting on file content would not pin this. Measured on linux, Node's
  // copyFileSync(x, x) returns normally and leaves the bytes intact (libuv
  // short-circuits a same-file copy), so a content assertion passes with the guard
  // deleted. Windows goes through CopyFileW instead and nothing here establishes it is
  // equally forgiving. The assertion that holds on every platform is that the call is
  // never made.
  it('does not copy the graph onto itself when both directories are the same', () => {
    const sameDir = mkTmp();
    fs.writeFileSync(path.join(sameDir, 'local.db'), 'the-only-graph');
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    migrateLocalDb(sameDir, sameDir);

    expect(copySpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(sameDir, 'local.db'), 'utf8')).toBe('the-only-graph');
  });

  // Positive control for the spy above: `not.toHaveBeenCalled()` on a spy that never
  // reached the subject passes whatever the subject does.
  it('the copy spy does observe a real migration (positive control)', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'local.db'), 'main');
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    migrateLocalDb(oldDir, newDir);

    expect(copySpy).toHaveBeenCalled();
  });
});

/**
 * legacyLocalDbDir()'s docblock says it "must never be updated to match getLocalDbPath()'s
 * current logic - the whole point is that it stays frozen as a historical record". That was
 * the only thing enforcing it. Measured on origin/main before these tests: rewriting the
 * function body to `return envPaths('align-cli', { suffix: '' }).config` left the suite at
 * 1414 passed, while silently reducing the migration to a no-op - old and new become equal,
 * so the `existsSync(newFile)` guard returns early and every existing user's graph stays
 * orphaned (ALI-824). A control that lives only in a comment is not a control.
 *
 * Each case is gated to the platform whose divergence it describes, so all three run
 * somewhere across the ubuntu/macos/windows CI matrix rather than being skipped everywhere.
 */
describe('legacyLocalDbDir stays frozen, and really does differ from the current directory', () => {
  const current = () => envPaths('align-cli', { suffix: '' }).config;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(process.platform === 'linux')(
    'linux: differs whenever XDG_CONFIG_HOME is set, because the legacy branch never read it',
    () => {
      vi.stubEnv('XDG_CONFIG_HOME', path.join(os.tmpdir(), 'align-xdg-elsewhere'));

      expect(legacyLocalDbDir()).not.toBe(current());
      // And name what it must still be, or "differs" is satisfied by any wrong answer.
      expect(legacyLocalDbDir()).toBe(path.join(os.homedir(), '.config', 'align-cli'));
    },
  );

  it.runIf(process.platform === 'win32')(
    'win32: differs by the Config subdirectory env-paths adds and the legacy branch did not',
    () => {
      const appData = path.join(os.tmpdir(), 'align-appdata');
      vi.stubEnv('APPDATA', appData);

      expect(legacyLocalDbDir()).not.toBe(current());
      expect(legacyLocalDbDir()).toBe(path.join(appData, 'align-cli'));
      expect(current()).toBe(path.join(appData, 'align-cli', 'Config'));
    },
  );

  it.runIf(process.platform === 'darwin')(
    'darwin: the two agree, which is why nothing migrates there',
    () => {
      expect(legacyLocalDbDir()).toBe(current());
      expect(legacyLocalDbDir()).toBe(
        path.join(os.homedir(), 'Library', 'Preferences', 'align-cli'),
      );
    },
  );
});
