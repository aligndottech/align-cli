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
    expect(vault.read(ACCOUNT)).toEqual({ status: 'found', value: SECRET });
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
  });

  it('read is null, not a throw, when the keychain has failed', () => {
    const { vault, tool } = working();
    tool.store.set(ACCOUNT, SECRET);
    tool.breakIt();
    expect(vault.read(ACCOUNT).status).toBe('failed');
  });

  it('remove deletes from the keychain', () => {
    const { vault, tool } = working();
    vault.write(ACCOUNT, SECRET);
    expect(vault.remove(ACCOUNT)).toBe('removed');
    expect(tool.store.size).toBe(0);
  });

  it('describe names the store in use', () => {
    const { vault } = working();
    expect(vault.describe()).toMatchObject({ store: 'keychain', forced: false });
    expect(vault.describe().label).toContain('libsecret');
  });

  it('probes the platform tool exactly once across many calls', () => {
    const tool = fakeTool('secret-tool');
    const vault = createTokenVault({ selection: () => selectBackend({ platform: 'linux', run: tool.run }) });
    vault.read(ACCOUNT); vault.read(ACCOUNT); vault.read('local:slack'); vault.write('local:jira', 'x'); vault.describe();
    const probes = tool.calls.filter((c) => c.args.includes('__align_probe__'));
    // Positive control: the lazy selection DID run, so zero cannot pass.
    expect(probes).toHaveLength(1);
  });
});



describe('a read that fails is not a read that finds nothing', () => {
  const vaultOn = (tool: ReturnType<typeof fakeTool>, notify: (m: string) => void = () => undefined) =>
    createTokenVault({ selection: selectBackend({ platform: 'linux', run: tool.run }), notify });

  it('absent for an account that is not there, failed for a store that errors', () => {
    const tool = fakeTool('secret-tool');
    const vault = vaultOn(tool);
    expect(vault.read('local:slack')).toEqual({ status: 'absent' });
    tool.store.set(ACCOUNT, SECRET);
    tool.breakIt('locked');
    const r = vault.read(ACCOUNT);
    expect(r.status).toBe('failed');
    expect(r.status === 'failed' && r.reason).toContain('locked');
  });

  it('asks the tool nothing more after its first failure, for reads, writes and removes', () => {
    const tool = fakeTool('secret-tool');
    const vault = vaultOn(tool);
    tool.breakIt('timed out');
    vault.read(ACCOUNT);
    const after = tool.calls.length;
    vault.read(ACCOUNT); vault.read('local:slack'); vault.write('local:jira', 'x'); vault.remove(ACCOUNT); vault.migrate('local:a', 'b');
    expect(tool.calls.length).toBe(after);
    expect(vault.remove(ACCOUNT)).toBe('failed');
  });

  it('reads with a short timeout', () => {
    const tool = fakeTool('secret-tool');
    const vault = vaultOn(tool);
    tool.store.set(ACCOUNT, SECRET);
    vault.read(ACCOUNT);
    const lookups = tool.calls.filter((c) => c.args[0] === 'lookup');
    expect(lookups.length).toBeGreaterThan(0);
    for (const c of lookups) expect(c.timeoutMs).toBeLessThanOrEqual(3_000);
  });

  it('says so once when a read fails, naming the store and why', () => {
    const tool = fakeTool('secret-tool');
    const notes: string[] = [];
    const vault = vaultOn(tool, (m) => notes.push(m));
    tool.breakIt('locked');
    vault.read(ACCOUNT); vault.read('local:slack');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('locked');
    expect(notes[0]).toMatch(/Secret Service|secret-tool/);
  });

  it('an account the config says is stored, with no usable store, is a failed read and not an absent one', () => {
    const tool = fakeTool('secret-tool');
    tool.breakIt('no secret service');
    const vault = vaultOn(tool);
    expect(vault.read(ACCOUNT, true).status).toBe('failed');
    expect(vault.read(ACCOUNT, false).status).toBe('absent');
  });

  it('migrates an account at most once per process', () => {
    const tool = fakeTool('secret-tool');
    tool.swallowWrites();
    const vault = vaultOn(tool);
    expect(vault.migrate(ACCOUNT, SECRET)).toBe(false);
    const after = tool.calls.length;
    expect(vault.migrate(ACCOUNT, SECRET)).toBe(false);
    expect(vault.migrate(ACCOUNT, SECRET)).toBe(false);
    expect(tool.calls.length).toBe(after);
  });

  it('remove reports no-store when there is none to ask', () => {
    const vault = createTokenVault({ selection: selectBackend({ platform: 'freebsd', run: fakeTool('security').run }), notify: () => undefined });
    expect(vault.remove(ACCOUNT)).toBe('no-store');
  });
});

describe('the Windows backend', () => {
  const blob = () => path.join(dir, 'blobs.json');
  const select = (env?: Record<string, string>) => {
    const tool = fakeTool('powershell');
    const sel = selectBackend({ platform: 'win32', run: tool.run, blobFile: blob(), ...(env ? { env } : {}) });
    return { tool, sel };
  };

  it('runs PowerShell by absolute path under SystemRoot, never by bare name', () => {
    const { tool, sel } = select({ SystemRoot: 'D:\\Win' });
    sel.backend!.set(ACCOUNT, SECRET);
    expect(tool.calls.length).toBeGreaterThan(0);
    for (const c of tool.calls) expect(c.cmd).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('falls back to C:\\Windows when SystemRoot is not set', () => {
    const { tool, sel } = select({});
    sel.backend!.get(ACCOUNT);
    sel.backend!.set(ACCOUNT, SECRET);
    for (const c of tool.calls) expect(c.cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('two sequential sets both persist', () => {
    const { sel } = select({});
    sel.backend!.set('local:github', 'one');
    sel.backend!.set('local:slack', 'two');
    expect(sel.backend!.get('local:github')).toBe('one');
    expect(sel.backend!.get('local:slack')).toBe('two');
  });

  it('writes the blob file by temp file and rename in the same folder', () => {
    const { sel } = select({});
    const rename = vi.spyOn(fs, 'renameSync');
    try {
      sel.backend!.set(ACCOUNT, SECRET);
      expect(rename).toHaveBeenCalledTimes(1);
      const [from, to] = rename.mock.calls[0] as [string, string];
      expect(to).toBe(blob());
      expect(path.dirname(from)).toBe(path.dirname(blob()));
      expect(from).not.toBe(to);
    } finally { rename.mockRestore(); }
    expect(fs.readdirSync(dir)).toEqual(['blobs.json']);
  });

  it('a truncated blob file is a loud failed read, with one notice, and the file is left as it was', () => {
    const tool = fakeTool('powershell');
    fs.writeFileSync(blob(), '{"local:github":"DPAPI-aa","local:sl');
    const before = fs.readFileSync(blob(), 'utf8');
    const notes: string[] = [];
    const vault = createTokenVault({ selection: selectBackend({ platform: 'win32', run: tool.run, blobFile: blob(), env: {} }), notify: (m) => notes.push(m) });
    expect(vault.read('local:github', true).status).toBe('failed');
    expect(vault.read('local:slack', true).status).toBe('failed');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('blobs.json');
    expect(fs.readFileSync(blob(), 'utf8')).toBe(before);
  });

  it('a write against a corrupt blob file falls back and never overwrites it', () => {
    const tool = fakeTool('powershell');
    fs.writeFileSync(blob(), '{not json');
    const vault = createTokenVault({ selection: selectBackend({ platform: 'win32', run: tool.run, blobFile: blob(), env: {} }), notify: () => undefined });
    expect(vault.write(ACCOUNT, SECRET).store).toBe('file');
    expect(fs.readFileSync(blob(), 'utf8')).toBe('{not json');
  });
});

describe('a secret never reaches a message', () => {
  const HEX = Buffer.from(SECRET).toString('hex');
  it.each([
    ['darwin', 'security'],
    ['linux', 'secret-tool'],
  ] as const)('%s: a tool that echoes the command line on stderr cannot leak the secret into the error or the notice', (platform, kind) => {
    const tool = fakeTool(kind);
    const notes: string[] = [];
    const sel = selectBackend({ platform, run: tool.run });
    tool.echoWrites();
    let thrown = '';
    try { sel.backend!.set(ACCOUNT, SECRET); } catch (e) { thrown = (e as Error).message; }
    expect(thrown).not.toBe('');
    const vault = createTokenVault({ selection: sel, notify: (m) => notes.push(m) });
    expect(vault.write(ACCOUNT, SECRET).store).toBe('file');
    const surfaced = [thrown, ...notes, JSON.stringify(vault.describe())].join('\n');
    expect(surfaced).not.toContain(SECRET);
    expect(surfaced).not.toContain(HEX);
    expect(notes).toHaveLength(1);
  });
});

describe('probes and blob values', () => {
  it.each([
    ['darwin', 'security'],
    ['win32', 'powershell'],
    ['linux', 'secret-tool'],
  ] as const)('%s: the availability probe uses the short read timeout, not the 15 s default', (platform, kind) => {
    const tool = fakeTool(kind);
    selectBackend({ platform, run: tool.run, blobFile: path.join(dir, 'blobs.json'), env: {} });
    expect(tool.calls.length).toBeGreaterThan(0);
    for (const c of tool.calls) expect(c.timeoutMs).toBeLessThanOrEqual(3_000);
  });

  it('a blob file with a non-string value is a loud failed read, left as it was', () => {
    const file = path.join(dir, 'blobs.json');
    fs.writeFileSync(file, JSON.stringify({ 'local:github': 5, 'local:slack': 'DPAPI-aa' }));
    const before = fs.readFileSync(file, 'utf8');
    const notes: string[] = [];
    const vault = createTokenVault({ selection: selectBackend({ platform: 'win32', run: fakeTool('powershell').run, blobFile: file, env: {} }), notify: (m) => notes.push(m) });
    expect(vault.read('local:slack', true).status).toBe('failed');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('blobs.json');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('a token longer than one command line (macOS `security -i` reads a bounded line)', () => {
  const mac = () => { const tool = fakeTool('security'); return { tool, b: backendFor('darwin', tool) }; };

  it.each([500, 1500, 2500, 3000, 9000])('round-trips a %i character token', (n) => {
    const { b } = mac();
    const long = `${'x'.repeat(n - 1)}Z`;
    b.set(ACCOUNT, long);
    expect(b.get(ACCOUNT)).toBe(long);
  });

  it('never sends a line past the limit, and the secret is still not in argv', () => {
    const { tool, b } = mac();
    b.set(ACCOUNT, 'y'.repeat(3000));
    for (const c of tool.calls) for (const l of (c.input ?? '').split('\n')) expect(l.length).toBeLessThanOrEqual(1024);
    expect(argvOf(tool.calls)).not.toContain('yyyyyyyyyy');
  });

  it('remove deletes every part, so nothing of the token stays behind', () => {
    const { tool, b } = mac();
    b.set(ACCOUNT, 'y'.repeat(3000));
    b.remove(ACCOUNT);
    expect(b.get(ACCOUNT)).toBeNull();
    expect(tool.store.size).toBe(0);
  });

  it('overwriting a long token with a short one leaves no stale parts', () => {
    const { tool, b } = mac();
    b.set(ACCOUNT, 'y'.repeat(3000));
    b.set(ACCOUNT, 'short');
    expect(b.get(ACCOUNT)).toBe('short');
    expect([...tool.store.keys()]).toEqual([ACCOUNT]);
  });

  it('overwriting a long token with a shorter long one drops the extra parts', () => {
    const { tool, b } = mac();
    b.set(ACCOUNT, 'y'.repeat(3000));
    const small = 'q'.repeat(1000);
    b.set(ACCOUNT, small);
    expect(b.get(ACCOUNT)).toBe(small);
    const after = tool.store.size;
    b.remove(ACCOUNT);
    expect(tool.store.size).toBe(0);
    expect(after).toBeLessThan(10);
  });

  it('a missing part is a failure, not a truncated token', () => {
    const { tool, b } = mac();
    b.set(ACCOUNT, 'y'.repeat(3000));
    const part = [...tool.store.keys()].find((k) => k !== ACCOUNT)!;
    tool.store.delete(part);
    expect(() => b.get(ACCOUNT)).toThrow(/part|incomplete|missing/i);
  });

  it('an error that quotes a slice of the hex line surfaces none of it', () => {
    const tool = fakeTool('security');
    const sel = selectBackend({ platform: 'darwin', run: tool.run });
    const fragmentRun: typeof tool.run = (cmd, args, opts) => {
      if (opts?.input?.includes('add-generic-password')) return { status: 1, stdout: '', stderr: `security: unknown command "${Buffer.from(SECRET.slice(5, 30)).toString('hex')}"` };
      return tool.run(cmd, args, opts);
    };
    const b = selectBackend({ platform: 'darwin', run: fragmentRun }).backend!;
    let msg = '';
    try { b.set(ACCOUNT, SECRET); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe('');
    expect(msg).not.toContain(Buffer.from(SECRET.slice(5, 30)).toString('hex').slice(0, 24));
    void sel;
  });
});
