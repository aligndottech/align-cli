import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchCacheDir } from '../lib/launch/launch-files.js';
import { migrateLocalDb } from '../lib/local-mode.js';
import { absoluteXdg, dropRelativeXdg, XDG_VARS } from '../lib/xdg.js';

/*
 * The XDG spec says a relative XDG_* value is invalid and must be ignored. It matters here
 * because an agent that loads a repo's `.env` (cn, Cline) hands its MCP children whatever that
 * file says: a repo `.env` with XDG_CONFIG_HOME=./evilcfg made `align mcp --env local` copy the
 * user's real local.db into <repo>/evilcfg/align-cli/. So align drops every relative XDG_* from
 * its own environment before anything reads it, and never migrates the db into the cwd.
 */
const dirs: string[] = [];
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-xdg-')));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('dropRelativeXdg / absoluteXdg', () => {
  it('drops each relative XDG_* and keeps each absolute one (all four variables)', () => {
    expect(XDG_VARS).toEqual(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']);
    const abs = path.resolve('/x');
    const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: './evilcfg', XDG_DATA_HOME: abs, XDG_CACHE_HOME: 'c', XDG_STATE_HOME: '', OTHER: './keep' };
    expect(dropRelativeXdg(env)).toEqual(['XDG_CONFIG_HOME', 'XDG_CACHE_HOME']);
    expect(env).toEqual({ XDG_DATA_HOME: abs, XDG_STATE_HOME: '', OTHER: './keep' });
  });
  it('absoluteXdg: the value only when absolute', () => {
    expect(absoluteXdg({ XDG_CACHE_HOME: './c' }, 'XDG_CACHE_HOME')).toBeUndefined();
    expect(absoluteXdg({ XDG_CACHE_HOME: path.resolve('/c') }, 'XDG_CACHE_HOME')).toBe(path.resolve('/c'));
    expect(absoluteXdg({}, 'XDG_CACHE_HOME')).toBeUndefined();
  });
  it('launchCacheDir goes through the same helper (a relative XDG_CACHE_HOME is ignored)', () => {
    expect(launchCacheDir({ XDG_CACHE_HOME: './c' })).not.toContain(`${path.sep}c${path.sep}align-cli`);
    expect(launchCacheDir({ XDG_CACHE_HOME: path.resolve('/c') })).toBe(path.join(path.resolve('/c'), 'align-cli', 'launch'));
  });
});

describe('migrateLocalDb never writes the db under the cwd', () => {
  const legacy = () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'local.db'), 'db');
    return d;
  };
  it('a target inside a repo cwd is refused: nothing is copied (an absolute XDG into the repo)', () => {
    const home = tmp();
    const repo = tmp();
    const target = path.join(repo, 'evilcfg', 'align-cli');
    migrateLocalDb(legacy(), target, { cwd: repo, home });
    expect(fs.existsSync(path.join(target, 'local.db'))).toBe(false);
  });
  it('control: the same target with the cwd elsewhere is migrated', () => {
    const home = tmp();
    const target = path.join(tmp(), 'cfg', 'align-cli');
    migrateLocalDb(legacy(), target, { cwd: tmp(), home });
    expect(fs.readFileSync(path.join(target, 'local.db'), 'utf8')).toBe('db');
  });
  it('running align from the home dir (or above it) still migrates into ~/.config', () => {
    const home = tmp();
    const target = path.join(home, '.config', 'align-cli');
    migrateLocalDb(legacy(), target, { cwd: home, home });
    expect(fs.existsSync(path.join(target, 'local.db'))).toBe(true);
    const home2 = tmp();
    const target2 = path.join(home2, '.config', 'align-cli');
    migrateLocalDb(legacy(), target2, { cwd: path.dirname(home2), home: home2 });
    expect(fs.existsSync(path.join(target2, 'local.db'))).toBe(true);
  });
});
