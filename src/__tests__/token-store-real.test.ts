/**
 * The REAL credential store, on the platform this runs on: macOS Keychain, the Linux Secret Service, Windows DPAPI.
 * Everything else in this suite uses fakes. This file exists because a fake can only show that the code agrees with the author's
 * idea of `security`, `secret-tool` and PowerShell; only the tools can say whether that idea is right.
 *
 * It runs ONLY when ALIGN_ALLOW_REAL_KEYCHAIN_IN_TESTS=1 (the CI jobs that prepare a keychain set it), so a normal `npm test` never
 * touches a keychain. It uses the real runner, wrapped only to record argv, and one account name per run, removed afterwards.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realRun, type Run, selectBackend, type Selection, type TokenBackend } from '../lib/token-store.js';
import { rmDir } from './helpers/rm-dir.js';

const enabled = process.env['ALIGN_ALLOW_REAL_KEYCHAIN_IN_TESTS'] === '1';

describe.skipIf(!enabled)('the real credential store', () => {
  const suffix = randomBytes(6).toString('hex');
  const a1 = `local:realtest-${suffix}-a`;
  const a2 = `local:realtest-${suffix}-b`;
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Run = (cmd, args, opts) => { calls.push({ cmd, args }); return realRun(cmd, args, opts); };
  let dir: string;
  let selection: Selection;
  let backend: TokenBackend;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-real-store-'));
    selection = selectBackend({ platform: process.platform, run, blobFile: path.join(dir, 'token-blobs.json') });
    if (selection.backend === null) throw new Error(`no usable credential store on ${process.platform}: ${String(selection.reason)}`);
    backend = selection.backend;
  });
  afterAll(() => {
    for (const a of [a1, a2]) { try { backend?.remove(a); } catch { /* best effort */ } }
    if (dir) rmDir(dir);
  });

  it('describes the store this platform should use', () => {
    const want = { darwin: 'macos-keychain', linux: 'libsecret', win32: 'windows-dpapi' }[process.platform as 'darwin' | 'linux' | 'win32'];
    expect(backend.id).toBe(want);
    expect(selection.forced).toBe(false);
    expect(selection.reason).toBeNull();
  });

  it('stores a token and reads the same value back', () => {
    const secret = `tok_${randomBytes(16).toString('hex')}`;
    backend.set(a1, secret);
    expect(backend.get(a1)).toBe(secret);
  });

  it('overwrites a stored token', () => {
    backend.set(a1, 'first-value');
    backend.set(a1, 'second-value');
    expect(backend.get(a1)).toBe('second-value');
  });

  it('removes a token, after which a read says absent', () => {
    backend.set(a1, 'to-be-removed');
    backend.remove(a1);
    expect(backend.get(a1)).toBeNull();
  });

  it('removing an account that is not there is not an error', () => {
    expect(() => { backend.remove(`local:realtest-${suffix}-never`); }).not.toThrow();
  });

  it('keeps two accounts apart', () => {
    backend.set(a1, 'value-one');
    backend.set(a2, 'value-two');
    expect(backend.get(a1)).toBe('value-one');
    expect(backend.get(a2)).toBe('value-two');
    backend.remove(a1);
    expect(backend.get(a1)).toBeNull();
    expect(backend.get(a2)).toBe('value-two');
  });

  it('stores a long token (3,000 characters, past any command-line limit) intact', () => {
    const long = randomBytes(1500).toString('hex');
    expect(long.length).toBe(3000);
    backend.set(a1, long);
    expect(backend.get(a1)).toBe(long);
  });

  it('stores a token with symbols a real one can carry', () => {
    const odd = 'xoxp-1234-abcd_EFGH+/=.~!@#$%^&*()[]{}|;:,<>?';
    backend.set(a1, odd);
    expect(backend.get(a1)).toBe(odd);
  });

  it('never puts a secret in argv, in any call made so far', () => {
    const secret = `argvcheck_${randomBytes(12).toString('hex')}`;
    const before = calls.length;
    backend.set(a2, secret);
    expect(backend.get(a2)).toBe(secret);
    const mine = calls.slice(before);
    // Positive control: the calls really were recorded.
    expect(mine.length).toBeGreaterThan(0);
    const hex = Buffer.from(secret).toString('hex');
    for (const c of mine) {
      const argv = [c.cmd, ...c.args].join(' ');
      expect(argv).not.toContain(secret);
      expect(argv).not.toContain(hex);
    }
  });
});
