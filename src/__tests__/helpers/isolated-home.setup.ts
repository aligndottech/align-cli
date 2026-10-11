/**
 * Vitest setup file: runs before each test file is imported. See `isolated-home.ts` for why
 * this has to happen before the import and not in a beforeEach.
 *
 * One temp home per test file, removed in afterAll. A process 'exit' hook does not work for
 * this: the pool stops its workers without one firing, and a first version of this file left
 * one folder per test file in the temp folder (1,300 after three full runs).
 *
 * Plain assignment, not vi.stubEnv: a suite calling vi.unstubAllEnvs() in afterEach would
 * otherwise restore the REAL home for every test after it in the file.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { assertIsolatedHome, REAL_HOME_ENV, TEST_HOME_ENV } from './isolated-home.js';
import { rmDir } from './rm-dir.js';

if (process.env[REAL_HOME_ENV] === undefined) {
  let realHome: string;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    realHome = os.homedir();
  }
  process.env[REAL_HOME_ENV] = realHome;
}

const home = mkdtempSync(path.join(os.tmpdir(), 'align-cli-test-home-'));
process.env[TEST_HOME_ENV] = home;
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
// The XDG overrides and Claude Code's own config override would win over HOME, so a developer
// who exports them would still reach their real folders.
for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR']) {
  delete process.env[k];
}
if (process.platform === 'win32') {
  for (const [k, sub] of [['APPDATA', 'AppData/Roaming'], ['LOCALAPPDATA', 'AppData/Local']] as const) {
    const dir = path.join(home, sub);
    mkdirSync(dir, { recursive: true });
    process.env[k] = dir;
  }
}

assertIsolatedHome();

afterAll(() => rmDir(home));
