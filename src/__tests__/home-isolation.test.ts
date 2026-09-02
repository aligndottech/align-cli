import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { createConfigStore } from '../lib/config.js';
import { getLocalDbPath } from '../lib/local-mode.js';

/**
 * The guard for vitest.config.ts's `setupFiles`. Delete that line and this file goes red,
 * rather than the suite quietly resuming migration of whoever runs it.
 *
 * Worth a test rather than a comment because the failure is invisible from the inside: a
 * non-hermetic run is green, fast, and identical to a hermetic one in every observable
 * except files written outside the repo, which nothing looks at.
 */
describe('the test suite runs against an isolated home directory', () => {
  const insideTmp = (p: string) => path.resolve(p).startsWith(path.resolve(os.tmpdir()));

  // os.homedir() is what production code actually reads (via env-paths), so this is the
  // assertion that matters. It takes HOME on POSIX and USERPROFILE on Windows, which is
  // why the setup sets both.
  it('os.homedir() resolves inside the temp directory, not the real user home', () => {
    expect(insideTmp(os.homedir())).toBe(true);
  });

  it.each(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA'])(
    '%s points inside the temp directory',
    (key) => {
      const value = process.env[key];

      expect(value).toBeDefined();
      expect(insideTmp(value as string)).toBe(true);
    },
  );

  // The two call sites that were measured writing real files. Asserting on the resolved
  // directory rather than on "no file appeared" is deliberate: "no file appeared" is also
  // what you get from a machine that happens to have no config to migrate, so it would
  // pass vacuously on CI and on any fresh checkout.
  it('both migration entry points resolve inside the temp directory', () => {
    createConfigStore();

    expect(insideTmp(envPaths('align-cli', { suffix: '' }).config)).toBe(true);
    expect(insideTmp(envPaths('align-cli', { suffix: 'nodejs' }).config)).toBe(true);
    expect(insideTmp(getLocalDbPath())).toBe(true);
  });

  // Positive control for the assertions above: prove insideTmp() can return false, or
  // every one of them would pass against any string at all.
  it('insideTmp rejects a path outside the temp directory (negative control)', () => {
    expect(insideTmp(path.join(path.sep as string, 'not', 'a', 'temp', 'path'))).toBe(false);
  });

  // And prove the isolated home is a real, writable directory rather than a plausible
  // string nothing ever created - the setup file makes it with mkdtempSync.
  it('the isolated home actually exists on disk', () => {
    expect(fs.existsSync(os.homedir())).toBe(true);
  });
});
