import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateConfigDirectory } from '../lib/config.js';

/**
 * This bug did not start tonight: `conf`'s own `projectSuffix: 'nodejs'` default has
 * been silently in effect since the CLI's first `align login`, so EVERY real user's
 * cloud auth token, tenant id and (as of ALI-802) saved connector tokens live at the
 * old suffixed path. Fixing where config.ts reads/writes without migrating that file
 * would log every existing user out on their next run - a real regression, not a
 * cosmetic one. This is the one-time, idempotent copy that prevents it.
 */
describe('migrateConfigDirectory', () => {
  const dirs: string[] = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'align-migrate-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('copies the old suffixed config to the new location when only the old one exists', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"defaultEnv":"prod"}');

    migrateConfigDirectory(oldDir, newDir);

    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe('{"defaultEnv":"prod"}');
  });

  // The old file is a backup, not a source to consume - a user inspecting their old
  // directory after upgrading should still find what was there.
  it('leaves the old file in place after copying', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"defaultEnv":"prod"}');

    migrateConfigDirectory(oldDir, newDir);

    expect(fs.existsSync(path.join(oldDir, 'config.json'))).toBe(true);
  });

  it('never overwrites a config that already exists at the new location', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"defaultEnv":"prod","stale":true}');
    fs.writeFileSync(path.join(newDir, 'config.json'), '{"defaultEnv":"preview","stale":false}');

    migrateConfigDirectory(oldDir, newDir);

    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe('{"defaultEnv":"preview","stale":false}');
  });

  it('does nothing when neither directory has a config file', () => {
    const oldDir = mkTmp();
    const newDir = mkTmp();

    expect(() => migrateConfigDirectory(oldDir, newDir)).not.toThrow();
    expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(false);
  });

  it('does nothing when the old directory does not exist at all (a genuinely fresh machine)', () => {
    const oldDir = path.join(os.tmpdir(), `align-migrate-never-created-${Math.random()}`);
    const newDir = mkTmp();

    expect(() => migrateConfigDirectory(oldDir, newDir)).not.toThrow();
    expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(false);
  });
});
