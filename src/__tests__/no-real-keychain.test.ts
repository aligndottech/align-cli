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

describe('every test that starts the real CLI with its own environment pins the token store', () => {
  // A hand-built env does not inherit vitest's ALIGN_TOKEN_STORE=file, so the real process would probe the machine's keychain: on a macOS
  // runner that blocked a seed hook past its 10 s limit. A file that starts the CLI must either spread process.env or name the pin.
  const testsDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const startsCli = (text: string): boolean =>
    /\b(execFile|execFileSync|spawn|spawnSync|execa|execaSync|StdioClientTransport|fork)\b/.test(text) &&
    /(src['"/, ]+index\.ts|'index\.ts'|dist[/\\]bin|bin\.js|entry\.mjs|'bin\.ts')/.test(text) &&
    /\benv\b\s*[:,}]/.test(text);
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.ts') && f !== 'no-real-keychain.test.ts');

  it('finds the e2e files it is meant to police (positive control)', () => {
    const hits = files.filter((f) => startsCli(fs.readFileSync(path.join(testsDir, f), 'utf8')));
    expect(hits).toEqual(expect.arrayContaining(['sync-telemetry-mcp-e2e.test.ts', 'launcher-child-telemetry-e2e.test.ts']));
  });

  it('each one names ALIGN_TOKEN_STORE or inherits process.env (spread, or the share-harness childEnv)', () => {
    const bad = files.filter((f) => {
      const text = fs.readFileSync(path.join(testsDir, f), 'utf8');
      return startsCli(text) && !text.includes('ALIGN_TOKEN_STORE') && !/\.\.\.process\.env|\bchildEnv\(/.test(text);
    });
    expect(bad).toEqual([]);
  });
});
