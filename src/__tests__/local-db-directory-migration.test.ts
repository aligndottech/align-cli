import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLocalDb } from '../lib/local-mode.js';

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
});
