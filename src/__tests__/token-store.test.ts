import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTokenVault, selectBackend, type TokenBackend } from '../lib/token-store.js';
import { fakeTool } from './helpers/fake-os-secret-tools.js';
import { rmDir } from './helpers/rm-dir.js';

const SECRET = 'ghp_SuperSecretValue1234567890abcdef';
const ACCOUNT = 'local:github';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-tokstore-')); });
afterEach(() => { rmDir(dir); });

const argvOf = (calls: Array<{ args: string[] }>): string => calls.flatMap((c) => c.args).join(' ');

function backendFor(platform: string, tool: ReturnType<typeof fakeTool>): TokenBackend {
  const sel = selectBackend({ platform, run: tool.run, blobFile: path.join(dir, 'blobs.json') });
  if (!sel.backend) throw new Error(`no backend for ${platform}: ${sel.reason}`);
  return sel.backend;
}

describe.each([
  ['darwin', 'security', 'macOS Keychain'],
  ['linux', 'secret-tool', 'libsecret'],
  ['win32', 'powershell', 'Windows DPAPI'],
] as const)('the %s backend', (platform, kind, label) => {
  it('selects the OS tool for the injected platform and names it', () => {
    const sel = selectBackend({ platform, run: fakeTool(kind).run, blobFile: path.join(dir, 'blobs.json') });
    expect(sel.backend?.label).toContain(label);
    expect(sel.forced).toBe(false);
  });

  it('round-trips a secret and the secret never appears in argv', () => {
    const tool = fakeTool(kind);
    const b = backendFor(platform, tool);
    b.set(ACCOUNT, SECRET);
    expect(b.get(ACCOUNT)).toBe(SECRET);
    expect(argvOf(tool.calls)).not.toContain(SECRET);
    // Positive control: the secret did travel, on stdin, to the tool.
    expect(tool.calls.some((c) => (c.input ?? '').includes(SECRET) || (c.input ?? '').includes(Buffer.from(SECRET).toString('hex')))).toBe(true);
  });

  it('returns null for an account that was never stored', () => {
    expect(backendFor(platform, fakeTool(kind)).get('local:slack')).toBeNull();
  });

  it('remove deletes it, and removing an absent account does not throw', () => {
    const b = backendFor(platform, fakeTool(kind));
    b.set(ACCOUNT, SECRET);
    b.remove(ACCOUNT);
    expect(b.get(ACCOUNT)).toBeNull();
    expect(() => b.remove(ACCOUNT)).not.toThrow();
  });

  it('a write the tool accepted but did not keep is an error, not a success', () => {
    const tool = fakeTool(kind);
    const b = backendFor(platform, tool);
    tool.swallowWrites();
    expect(() => b.set(ACCOUNT, SECRET)).toThrow(/did not keep|did not produce/i);
  });

  it('refuses an account name that is not plain', () => {
    expect(() => backendFor(platform, fakeTool(kind)).set('local:x" -w pwned', SECRET)).toThrow(/account/i);
  });
});

describe('the Windows blob file', () => {
  it('holds only the protected blob, never the secret', () => {
    const tool = fakeTool('powershell');
    const file = path.join(dir, 'blobs.json');
    backendFor('win32', tool).set(ACCOUNT, SECRET);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('DPAPI-');
    expect(text).not.toContain(SECRET);
  });
});

describe('selectBackend when nothing works', () => {
  it('names secret-tool when Linux has no secret service', () => {
    const tool = fakeTool('secret-tool');
    tool.breakIt('Cannot autolaunch D-Bus without X11 $DISPLAY');
    const sel = selectBackend({ platform: 'linux', run: tool.run });
    expect(sel.backend).toBeNull();
    expect(sel.reason).toMatch(/secret-tool|Secret Service/);
    expect(sel.reason).toContain('D-Bus');
  });
  it('says so for a platform with no store', () => {
    const sel = selectBackend({ platform: 'freebsd', run: fakeTool('security').run });
    expect(sel.backend).toBeNull();
    expect(sel.reason).toContain('freebsd');
  });
  it('mode "file" is an explicit choice, recorded as forced', () => {
    const sel = selectBackend({ platform: 'darwin', run: fakeTool('security').run, mode: 'file' });
    expect(sel.backend).toBeNull();
    expect(sel.forced).toBe(true);
  });
});

describe('the vault', () => {
  const working = (): { vault: ReturnType<typeof createTokenVault>; tool: ReturnType<typeof fakeTool>; notes: string[] } => {
    const tool = fakeTool('secret-tool');
    const notes: string[] = [];
    const vault = createTokenVault({ selection: selectBackend({ platform: 'linux', run: tool.run }), notify: (m) => notes.push(m) });
    return { vault, tool, notes };
  };

  it('writes to the keychain and reads it back, with no notice', () => {
    const { vault, notes } = working();
    expect(vault.write(ACCOUNT, SECRET).store).toBe('keychain');
    expect(vault.read(ACCOUNT)).toBe(SECRET);
    expect(notes).toEqual([]);
  });

  it('falls back to the file when the keychain write fails, and says so once, naming the store and why', () => {
    const { vault, tool, notes } = working();
    tool.breakIt('no secret service');
    const r = vault.write(ACCOUNT, SECRET);
    expect(r.store).toBe('file');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Secret Service|secret-tool/);
    expect(notes[0]).toContain('no secret service');
    expect(notes[0]).toMatch(/config file|owner-only|0600/);
    vault.write('local:slack', 'x-token');
    expect(notes).toHaveLength(1);
  });

  it('says so when no backend exists at all, once', () => {
    const notes: string[] = [];
    const vault = createTokenVault({ selection: selectBackend({ platform: 'freebsd', run: fakeTool('security').run }), notify: (m) => notes.push(m) });
    expect(vault.write(ACCOUNT, SECRET).store).toBe('file');
    vault.write('local:slack', 'x');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('freebsd');
  });

  it('an explicit file choice falls back with no notice', () => {
    const notes: string[] = [];
    const vault = createTokenVault({ selection: selectBackend({ platform: 'darwin', run: fakeTool('security').run, mode: 'file' }), notify: (m) => notes.push(m) });
    expect(vault.write(ACCOUNT, SECRET)).toMatchObject({ store: 'file' });
    expect(notes).toEqual([]);
    expect(vault.describe()).toMatchObject({ store: 'file', forced: true });
  });

  it('a write the tool swallowed falls back instead of claiming success', () => {
    const { vault, tool } = working();
    tool.swallowWrites();
    expect(vault.write(ACCOUNT, SECRET).store).toBe('file');
  });

  it('migrate reports true only when the keychain really holds the secret, and never throws', () => {
    const { vault, tool } = working();
    expect(vault.migrate(ACCOUNT, SECRET)).toBe(true);
    tool.breakIt();
    expect(vault.migrate('local:slack', 'x')).toBe(false);
    expect(vault.read('local:slack')).toBeNull();
  });

  it('read is null, not a throw, when the keychain has failed', () => {
    const { vault, tool } = working();
    tool.store.set(ACCOUNT, SECRET);
    tool.breakIt();
    expect(vault.read(ACCOUNT)).toBeNull();
  });

  it('remove deletes from the keychain', () => {
    const { vault, tool } = working();
    vault.write(ACCOUNT, SECRET);
    vault.remove(ACCOUNT);
    expect(tool.store.size).toBe(0);
  });

  it('describe names the store in use', () => {
    const { vault } = working();
    expect(vault.describe()).toMatchObject({ store: 'keychain', forced: false });
    expect(vault.describe().label).toContain('libsecret');
  });

  it('probes the platform tool once, not on every call', () => {
    const { vault, tool } = working();
    vault.read(ACCOUNT); vault.read(ACCOUNT); vault.read(ACCOUNT);
    const probes = tool.calls.filter((c) => c.args[0] === 'lookup' && c.args.includes('__align_probe__'));
    expect(probes.length).toBeLessThanOrEqual(1);
  });
});

void vi;
