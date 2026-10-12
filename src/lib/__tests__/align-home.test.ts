import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../config.js';
import { alignConfigDir } from '../private-files.js';
import { getLocalDbPath } from '../local-mode.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'align-home-'));
  vi.stubEnv('HOME', home);
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere. Stub both, or the Windows CI leg
  // resolves the runner's real home folder and every assertion below compares the wrong directory.
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('one folder for everything align keeps: ~/.align', () => {
  it('the config directory is ~/.align, whatever XDG_CONFIG_HOME says', () => {
    expect(alignConfigDir()).toBe(path.join(home, '.align'));
  });

  it('the config store writes config.json into ~/.align', () => {
    const store = createConfigStore();
    store.setDetector('v0');
    expect(fs.existsSync(path.join(home, '.align', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.config', 'align-cli', 'config.json'))).toBe(false);
  });

  it('the local graph lives in ~/.align/local.db', () => {
    expect(getLocalDbPath()).toBe(path.join(home, '.align', 'local.db'));
  });
});
