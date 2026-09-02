import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { getLocalDbPath, legacyLocalDbDir, migrateLocalDbDirectory } from '../lib/local-mode.js';

/**
 * The sibling of migrateConfigDirectory, for the OTHER half of local state.
 *
 * Moving getLocalDbPath() onto env-paths fixed the split this whole change is about, and
 * relocated the local graph DB on two platforms while doing it:
 *
 *   - win32: %APPDATA%/align-cli/local.db becomes %APPDATA%/align-cli/Config/local.db,
 *     because env-paths nests config under a `Config` subdirectory the hand-rolled branch
 *     never added
 *   - linux with XDG_CONFIG_HOME set: ~/.config/align-cli becomes $XDG_CONFIG_HOME/align-cli,
 *     because the hand-rolled branch never honoured XDG
 *
 * macOS and default Linux are unaffected, which is exactly why the manual end-to-end proof
 * could not surface this: the fixture never crossed the boundary. Without a migration,
 * `align setup --local` on those two platforms silently repoints an existing user at an
 * empty graph and stores that new path over the old one - the same "silently log everyone
 * out" regression migrateConfigDirectory exists to prevent, applied to the decisions rather
 * than the tokens.
 */
describe('migrateLocalDbDirectory', () => {
  const dirs: string[] = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'align-db-migrate-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('copies the legacy DB to the new location when only the legacy one exists', () => {
    const legacyDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(legacyDir, 'local.db'), 'SQLite format 3 decisions');

    migrateLocalDbDirectory(legacyDir, newDir);

    expect(fs.readFileSync(path.join(newDir, 'local.db'), 'utf8')).toBe(
      'SQLite format 3 decisions',
    );
  });

  // The second example, and the one that forces the implementation past "copy local.db".
  // The DB runs in WAL mode (local-db.ts: PRAGMA journal_mode = WAL), so committed
  // transactions live in the -wal sidecar until a checkpoint. Copying the main file alone
  // is a copy that loses the most recent decisions and reports success.
  it('copies the -wal and -shm sidecars alongside it', () => {
    const legacyDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(legacyDir, 'local.db'), 'main');
    fs.writeFileSync(path.join(legacyDir, 'local.db-wal'), 'uncheckpointed-writes');
    fs.writeFileSync(path.join(legacyDir, 'local.db-shm'), 'shared-memory-index');

    migrateLocalDbDirectory(legacyDir, newDir);

    expect(fs.readFileSync(path.join(newDir, 'local.db-wal'), 'utf8')).toBe('uncheckpointed-writes');
    expect(fs.readFileSync(path.join(newDir, 'local.db-shm'), 'utf8')).toBe('shared-memory-index');
  });

  // Same contract as migrateConfigDirectory: the legacy copy is a backup, never consumed.
  it('leaves the legacy files in place after copying', () => {
    const legacyDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(legacyDir, 'local.db'), 'main');
    fs.writeFileSync(path.join(legacyDir, 'local.db-wal'), 'wal');

    migrateLocalDbDirectory(legacyDir, newDir);

    expect(fs.existsSync(path.join(legacyDir, 'local.db'))).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, 'local.db-wal'))).toBe(true);
  });

  it('never overwrites a DB that already exists at the new location', () => {
    const legacyDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(legacyDir, 'local.db'), 'stale-legacy-graph');
    fs.writeFileSync(path.join(newDir, 'local.db'), 'the-graph-in-use');

    migrateLocalDbDirectory(legacyDir, newDir);

    expect(fs.readFileSync(path.join(newDir, 'local.db'), 'utf8')).toBe('the-graph-in-use');
  });

  // Worse than overwriting the DB: grafting a foreign -wal onto a different database is how
  // SQLite gets handed committed frames belonging to another file. All three move together
  // or none do.
  it('copies no sidecar either when the new location already has a DB', () => {
    const legacyDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(legacyDir, 'local.db'), 'stale-legacy-graph');
    fs.writeFileSync(path.join(legacyDir, 'local.db-wal'), 'frames-for-a-different-database');
    fs.writeFileSync(path.join(newDir, 'local.db'), 'the-graph-in-use');

    migrateLocalDbDirectory(legacyDir, newDir);

    expect(fs.existsSync(path.join(newDir, 'local.db-wal'))).toBe(false);
  });

  it('does nothing when neither directory has a DB', () => {
    const legacyDir = mkTmp();
    const newDir = mkTmp();

    expect(() => migrateLocalDbDirectory(legacyDir, newDir)).not.toThrow();
    expect(fs.existsSync(path.join(newDir, 'local.db'))).toBe(false);
  });

  it('does nothing when the legacy directory does not exist at all (a fresh machine)', () => {
    const legacyDir = path.join(os.tmpdir(), `align-db-never-created-${Math.random()}`);
    const newDir = mkTmp();

    expect(() => migrateLocalDbDirectory(legacyDir, newDir)).not.toThrow();
    expect(fs.existsSync(path.join(newDir, 'local.db'))).toBe(false);
  });

  // macOS and default Linux, i.e. most machines: the two derivations already agree, so the
  // migration must decline rather than copy the graph onto itself.
  //
  // Asserting only on the file content would not pin this. Measured on linux, Node's
  // copyFileSync(x, x) returns normally and leaves the bytes intact - libuv short-circuits
  // a same-file copy - so the content assertion passes with the guard deleted, and it was
  // an injection reddening 2 tests where 3 were predicted that surfaced it. Windows goes
  // through CopyFileW instead, and nothing here establishes it is equally forgiving. So the
  // assertion that matters is that we never make the call: the guard delivers this on every
  // platform, and the platform's copy semantics are not something to depend on.
  it('does not copy the DB onto itself when the legacy and new directories are the same', () => {
    const sameDir = mkTmp();
    fs.writeFileSync(path.join(sameDir, 'local.db'), 'the-only-graph');
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    migrateLocalDbDirectory(sameDir, sameDir);

    expect(copySpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(sameDir, 'local.db'), 'utf8')).toBe('the-only-graph');
  });

  // Positive control for the spy above: a `not.toHaveBeenCalled()` on a spy that was never
  // wired to the subject passes whatever the subject does. This proves the same spy sees
  // the call on the one path that should make it.
  it('the copy spy does observe a real migration (positive control)', () => {
    const legacyDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(legacyDir, 'local.db'), 'main');
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    migrateLocalDbDirectory(legacyDir, newDir);

    expect(copySpy).toHaveBeenCalled();
  });
});

/**
 * The unit tests above prove the copy semantics against directories handed in by the test.
 * These prove the thing that actually bites: that the two derivations really do diverge on
 * this platform, and that getLocalDbPath() closes the gap end to end. Each is gated to the
 * platform whose divergence it describes, so all three run somewhere across the
 * ubuntu/macos/windows CI matrix rather than being skipped everywhere.
 */
describe('getLocalDbPath migrates across a real platform divergence', () => {
  const dirs: string[] = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'align-db-platform-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it.runIf(process.platform === 'linux')(
    'linux: an XDG_CONFIG_HOME machine keeps the graph it already had',
    () => {
      const home = mkTmp();
      const xdg = mkTmp();
      vi.stubEnv('HOME', home);
      vi.stubEnv('XDG_CONFIG_HOME', xdg);

      // Positive control: without it, two paths that happened to be equal would make the
      // assertion below pass while migrating nothing.
      expect(legacyLocalDbDir()).not.toBe(envPaths('align-cli', { suffix: '' }).config);

      const legacyDb = path.join(home, '.config', 'align-cli', 'local.db');
      fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
      fs.writeFileSync(legacyDb, 'decisions-imported-before-the-upgrade');

      expect(fs.readFileSync(getLocalDbPath(), 'utf8')).toBe(
        'decisions-imported-before-the-upgrade',
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'win32: the Config subdirectory env-paths adds does not orphan the graph',
    () => {
      const appData = mkTmp();
      vi.stubEnv('APPDATA', appData);

      expect(legacyLocalDbDir()).not.toBe(envPaths('align-cli', { suffix: '' }).config);

      const legacyDb = path.join(appData, 'align-cli', 'local.db');
      fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
      fs.writeFileSync(legacyDb, 'decisions-imported-before-the-upgrade');

      expect(fs.readFileSync(getLocalDbPath(), 'utf8')).toBe(
        'decisions-imported-before-the-upgrade',
      );
    },
  );

  it.runIf(process.platform === 'darwin')(
    'darwin: the two derivations already agree, so there is nothing to migrate',
    () => {
      expect(legacyLocalDbDir()).toBe(envPaths('align-cli', { suffix: '' }).config);
    },
  );
});
