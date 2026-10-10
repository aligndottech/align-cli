import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shareSalt } from '../lib/share/salt.js';

/**
 * L9 second review, item 6: the share salt is its own random per-install secret, in the CLI's private state
 * directory (0600), stable across calls, and unrelated to anything else the CLI keeps (the telemetry install id).
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-salt-')); vi.stubEnv('XDG_STATE_HOME', dir); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('shareSalt', () => {
  it('is 64 hex characters, created once, stable, and stored private', () => {
    const a = shareSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(shareSalt()).toBe(a);
    const file = path.join(dir, 'align-cli', 'share-salt');
    expect(fs.readFileSync(file, 'utf8')).toBe(a);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
  it('a damaged file is replaced, not trusted', () => {
    const a = shareSalt();
    fs.writeFileSync(path.join(dir, 'align-cli', 'share-salt'), 'not-a-salt');
    const b = shareSalt();
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe('not-a-salt');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
