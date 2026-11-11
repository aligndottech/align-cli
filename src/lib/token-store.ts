/**
 * Where a connector token lives: the OS credential store when there is one, the config file when
 * there is not, and never a silent switch between them.
 *
 * Three backends, one small interface, and an injected `Run` so tests never touch a real keychain:
 *
 * - macOS: Keychain, through /usr/bin/security.
 * - Linux: the Secret Service (GNOME Keyring, KWallet), through secret-tool.
 * - Windows: DPAPI through PowerShell. DPAPI encrypts for the signed-in user; the encrypted blob
 *   sits in a small file beside the config, because DPAPI has no store of its own.
 *
 * A secret NEVER goes in argv, where `ps` shows it to every user on the machine. It travels on the
 * tool's stdin. The macOS path is `security -i` (commands on stdin) with the secret hex-encoded,
 * which also removes any quoting question. Nothing here uses a shell, and no native npm module.
 *
 * Every write is read back before it counts. `security -i` can exit 0 on a command that failed,
 * and a store that accepted a write and kept nothing would lose the token the moment the caller
 * removed its plaintext copy. A write that does not read back is a failed write.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunResult { status: number | null; stdout: string; stderr: string }
/** Run a program with no shell. `input` is written to its stdin. */
export type Run = (cmd: string, args: string[], opts?: { input?: string }) => RunResult;

export const realRun: Run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    input: opts?.input,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
};

export interface TokenBackend {
  id: 'macos-keychain' | 'libsecret' | 'windows-dpapi';
  /** What a person calls it, for the notice and for doctor. */
  label: string;
  /** null when usable, else the reason it is not. */
  probe(): string | null;
  /** The stored secret, or null when there is none. Throws when the store itself fails. */
  get(account: string): string | null;
  /** Stores and reads back. Throws when the store failed or did not keep it. */
  set(account: string, secret: string): void;
  /** Removing an account that is not there is not an error. */
  remove(account: string): void;
}

const SERVICE = 'align-cli';
const PROBE_ACCOUNT = '__align_probe__';
/** Accounts are `<env>:<source>`. Anything else never reaches a command line. */
const ACCOUNT = /^[A-Za-z0-9._:-]{1,200}$/;

function checkAccount(account: string): string {
  if (!ACCOUNT.test(account)) throw new Error(`token store: "${account.slice(0, 40)}" is not a plain account name`);
  return account;
}

const firstLine = (s: string): string => s.trim().split('\n')[0]?.trim() ?? '';
const notKept = (label: string): Error => new Error(`${label} accepted the write but did not keep the token`);

function macBackend(run: Run): TokenBackend {
  const label = 'macOS Keychain';
  const get = (account: string): string | null => {
    const r = run('/usr/bin/security', ['find-generic-password', '-a', checkAccount(account), '-s', SERVICE, '-w']);
    if (r.status === 0) return r.stdout.replace(/\r?\n$/, '');
    if (r.status === 44) return null; // errSecItemNotFound
    throw new Error(`${label}: ${firstLine(r.stderr) || `security exited ${String(r.status)}`}`);
  };
  return {
    id: 'macos-keychain',
    label,
    probe: () => {
      const r = run('/usr/bin/security', ['list-keychains']);
      return r.status === 0 ? null : (firstLine(r.stderr) || '/usr/bin/security is not usable');
    },
    get,
    set(account, secret) {
      checkAccount(account);
      // The command line goes on stdin, so the secret is not in argv. Hex, so no character in a token can end the argument.
      const line = `add-generic-password -U -a "${account}" -s "${SERVICE}" -X ${Buffer.from(secret, 'utf8').toString('hex')}\n`;
      const r = run('/usr/bin/security', ['-i'], { input: line });
      if (r.status !== 0) throw new Error(`${label}: ${firstLine(r.stderr) || `security exited ${String(r.status)}`}`);
      if (get(account) !== secret) throw notKept(label);
    },
    remove(account) {
      const r = run('/usr/bin/security', ['delete-generic-password', '-a', checkAccount(account), '-s', SERVICE]);
      if (r.status !== 0 && r.status !== 44) throw new Error(`${label}: ${firstLine(r.stderr) || `security exited ${String(r.status)}`}`);
    },
  };
}

function libsecretBackend(run: Run): TokenBackend {
  const label = 'Secret Service (libsecret, via secret-tool)';
  const lookup = (account: string): string | null => {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    if (r.status === 0) return r.stdout;
    // secret-tool exits 1 with nothing on stderr for "no such item"; a missing binary or D-Bus failure says why.
    if (r.status === 1 && r.stderr.trim() === '') return null;
    throw new Error(`secret-tool: ${firstLine(r.stderr) || `exited ${String(r.status)}`}`);
  };
  return {
    id: 'libsecret',
    label,
    probe: () => {
      try { lookup(PROBE_ACCOUNT); return null; } catch (e) { return (e as Error).message; }
    },
    get: (account) => lookup(checkAccount(account)),
    set(account, secret) {
      checkAccount(account);
      // `secret-tool store` reads the secret from stdin when it is not a terminal. No trailing newline: it would be part of the secret.
      const r = run('secret-tool', ['store', '--label', `Align CLI ${account}`, 'service', SERVICE, 'account', account], { input: secret });
      if (r.status !== 0) throw new Error(`secret-tool: ${firstLine(r.stderr) || `exited ${String(r.status)}`}`);
      if (lookup(account) !== secret) throw notKept(label);
    },
    remove(account) {
      const r = run('secret-tool', ['clear', 'service', SERVICE, 'account', checkAccount(account)]);
      if (r.status !== 0 && r.status !== 1) throw new Error(`secret-tool: ${firstLine(r.stderr) || `exited ${String(r.status)}`}`);
    },
  };
}

// DPAPI through PowerShell. The scripts hold no secret: it comes in on stdin and the plaintext comes back on stdout.
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const PS_PROTECT =
  "$ErrorActionPreference='Stop'; $s=[Console]::In.ReadToEnd().TrimEnd(\"`r\",\"`n\"); " +
  'ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString';
const PS_UNPROTECT =
  "$ErrorActionPreference='Stop'; $b=[Console]::In.ReadToEnd().Trim(); $ss=ConvertTo-SecureString $b; " +
  '$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); ' +
  'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }';

function windowsBackend(run: Run, blobFile: string): TokenBackend {
  const label = 'Windows DPAPI (encrypted for your Windows account)';
  const ps = (script: string, input?: string): RunResult => run('powershell.exe', [...PS_ARGS, script], input === undefined ? undefined : { input });
  const readBlobs = (): Record<string, string> => {
    try {
      const v = JSON.parse(fs.readFileSync(blobFile, 'utf8')) as unknown;
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return {};
      throw new Error(`could not read ${blobFile}: ${(e as Error).message}`);
    }
  };
  const writeBlobs = (blobs: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(blobFile), { recursive: true });
    fs.writeFileSync(blobFile, JSON.stringify(blobs), { mode: 0o600 });
  };
  const get = (account: string): string | null => {
    const blob = readBlobs()[checkAccount(account)];
    if (blob === undefined) return null;
    const r = ps(PS_UNPROTECT, blob);
    if (r.status !== 0) throw new Error(`DPAPI: ${firstLine(r.stderr) || `powershell exited ${String(r.status)}`}`);
    return r.stdout.replace(/\r?\n$/, '');
  };
  return {
    id: 'windows-dpapi',
    label,
    probe: () => {
      const r = ps('exit 0');
      return r.status === 0 ? null : (firstLine(r.stderr) || 'powershell.exe is not usable');
    },
    get,
    set(account, secret) {
      checkAccount(account);
      const r = ps(PS_PROTECT, secret);
      const blob = r.stdout.trim();
      if (r.status !== 0 || blob === '') throw new Error(`DPAPI: ${firstLine(r.stderr) || 'did not produce an encrypted value'}`);
      const before = readBlobs();
      writeBlobs({ ...before, [account]: blob });
      if (get(account) !== secret) {
        writeBlobs(before);
        throw notKept(label);
      }
    },
    remove(account) {
      const blobs = readBlobs();
      if (!(checkAccount(account) in blobs)) return;
      const { [account]: _gone, ...rest } = blobs;
      writeBlobs(rest);
    },
  };
}

export interface Selection {
  backend: TokenBackend | null;
  /** The store a person would expect on this platform, for the notice. */
  label: string;
  /** Why there is no backend. null when there is one. */
  reason: string | null;
  /** The person asked for the file (ALIGN_TOKEN_STORE=file). Not a fallback, so no notice. */
  forced: boolean;
}

export interface SelectOptions {
  /** process.platform, injected so each backend is testable anywhere. */
  platform: string;
  run: Run;
  /** 'file' skips the OS store on purpose. */
  mode?: string;
  /** Windows only: where the DPAPI blobs are kept. */
  blobFile?: string;
}

export function selectBackend(o: SelectOptions): Selection {
  if (o.mode === 'file') return { backend: null, label: 'the config file', reason: 'ALIGN_TOKEN_STORE=file', forced: true };
  let backend: TokenBackend | null = null;
  if (o.platform === 'darwin') backend = macBackend(o.run);
  else if (o.platform === 'linux') backend = libsecretBackend(o.run);
  else if (o.platform === 'win32') backend = windowsBackend(o.run, o.blobFile ?? 'align-token-blobs.json');
  if (backend === null) return { backend: null, label: 'an OS credential store', reason: `no credential store is supported on ${o.platform}`, forced: false };
  const problem = backend.probe();
  if (problem !== null) return { backend: null, label: backend.label, reason: problem, forced: false };
  return { backend, label: backend.label, reason: null, forced: false };
}

export type WriteResult = { store: 'keychain'; label: string } | { store: 'file'; reason: string };

export interface TokenVault {
  /** The secret from the OS store, or null (absent, or the store failed). */
  read(account: string): string | null;
  /** To the OS store, verified. 'file' means the caller must keep the secret in the config file, and has been told why. */
  write(account: string, secret: string): WriteResult;
  /** Like write, for a secret already on disk: true only when the OS store verifiably holds it. Silent on failure. */
  migrate(account: string, secret: string): boolean;
  /** false when the OS store could not remove it. */
  remove(account: string): boolean;
  describe(): { store: 'keychain' | 'file'; label: string; reason: string | null; forced: boolean };
}

export interface VaultOptions {
  selection: Selection | (() => Selection);
  /** Told once when a write falls back to the file. */
  notify?: (message: string) => void;
  now?: () => number;
}

const READ_TTL_MS = 5_000;

export function createTokenVault(o: VaultOptions): TokenVault {
  let chosen: Selection | undefined;
  const sel = (): Selection => (chosen ??= typeof o.selection === 'function' ? o.selection() : o.selection);
  const now = o.now ?? Date.now;
  let notified = false;
  // Only hits are cached, briefly: a miss must stay a live question, because another `align` process may save the token a moment later.
  const hits = new Map<string, { value: string; at: number }>();

  const fallback = (reason: string): WriteResult => {
    const s = sel();
    if (!s.forced && !notified) {
      notified = true;
      o.notify?.(
        `Align could not use ${s.label}: ${reason}. ` +
        'Saving connector tokens in its config file instead (owner-only, mode 0600). Run `align doctor` to see which store is in use.',
      );
    }
    return { store: 'file', reason };
  };

  return {
    read(account) {
      const b = sel().backend;
      if (b === null) return null;
      const hit = hits.get(account);
      if (hit && now() - hit.at < READ_TTL_MS) return hit.value;
      try {
        const v = b.get(account);
        if (v === null) { hits.delete(account); return null; }
        hits.set(account, { value: v, at: now() });
        return v;
      } catch { return null; }
    },
    write(account, secret) {
      const s = sel();
      hits.delete(account);
      if (s.backend === null) return fallback(s.reason ?? 'no credential store');
      try {
        s.backend.set(account, secret);
        hits.set(account, { value: secret, at: now() });
        return { store: 'keychain', label: s.backend.label };
      } catch (e) {
        return fallback((e as Error).message);
      }
    },
    migrate(account, secret) {
      const b = sel().backend;
      hits.delete(account);
      if (b === null) return false;
      try { b.set(account, secret); hits.set(account, { value: secret, at: now() }); return true; } catch { return false; }
    },
    remove(account) {
      const b = sel().backend;
      hits.delete(account);
      if (b === null) return true;
      try { b.remove(account); return true; } catch { return false; }
    },
    describe() {
      const s = sel();
      return s.backend ? { store: 'keychain', label: s.backend.label, reason: null, forced: false } : { store: 'file', label: 'the config file', reason: s.reason, forced: s.forced };
    },
  };
}

/** The real thing, chosen lazily so a command that never touches a token never spawns a tool. */
export function defaultTokenVault(opts: { blobFile?: string; notify?: (m: string) => void } = {}): TokenVault {
  return createTokenVault({
    selection: () => selectBackend({
      platform: process.platform,
      run: realRun,
      ...(process.env['ALIGN_TOKEN_STORE'] === undefined ? {} : { mode: process.env['ALIGN_TOKEN_STORE'] }),
      ...(opts.blobFile === undefined ? {} : { blobFile: opts.blobFile }),
    }),
    notify: opts.notify ?? ((m) => { console.error(m); }),
  });
}
