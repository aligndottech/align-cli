import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTokenVault, realRun } from '../lib/token-store.js';
import { rmDir } from './helpers/rm-dir.js';

/**
 * No test, and no process a test starts, may reach a real macOS Keychain, secret-tool or DPAPI: on a CI runner a real
 * `security` call can block past the hook timeout, and on a developer machine it would read and write their own tokens.
 */
let dir: string;
let marker: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-nokeychain-')); marker = path.join(dir, 'ran'); });
afterEach(() => { vi.unstubAllEnvs(); rmDir(dir); });

const touchMarker = (): ReturnType<typeof realRun> =>
  realRun(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);

describe('the real runner under a test', () => {
  it('starts nothing, and reports that it refused', () => {
    vi.stubEnv('ALIGN_ALLOW_REAL_KEYCHAIN_IN_TESTS', undefined);
    const r = touchMarker();
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.status).toBeNull();
    expect(r.stderr).toMatch(/test/i);
  });

  it('positive control: with the deliberate override the same call does run', () => {
    vi.stubEnv('ALIGN_ALLOW_REAL_KEYCHAIN_IN_TESTS', '1');
    touchMarker();
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('the test environment', () => {
  it('pins the token store to the file, so a child that inherits it cannot probe a real keychain either', () => {
    expect(process.env['ALIGN_TOKEN_STORE']).toBe('file');
  });

  it('the default vault under that pin chooses the file without asking any tool', () => {
    vi.stubEnv('ALIGN_TOKEN_STORE', 'file');
    expect(defaultTokenVault().describe()).toMatchObject({ store: 'file', forced: true });
  });
});
