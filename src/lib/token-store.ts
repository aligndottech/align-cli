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
export type Run = (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => RunResult;

/** A read is on the hot path of every command and of the MCP loop, so a locked store must not hold it for long. */
export const READ_TIMEOUT_MS = 3_000;
const WRITE_TIMEOUT_MS = 15_000;

export const realRun: Run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    input: opts?.input,
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? WRITE_TIMEOUT_MS,
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
/**
 * `security -i` can echo the line it failed to parse, which carries the secret (hex-encoded). Whatever a tool says on stderr is
 * scrubbed of the secret, in both spellings, before it can reach an Error, the notice or doctor.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === '') continue;
    const hex = Buffer.from(secret, 'utf8').toString('hex');
    for (const form of [secret, hex, hex.toUpperCase(), Buffer.from(secret, 'utf8').toString('base64')]) out = out.split(form).join('[redacted]');
  }
  return out;
}
const notKept = (label: string): Error => new Error(`${label} accepted the write but did not keep the token`);

function macBackend(run: Run): TokenBackend {
  const label = 'macOS Keychain';
  const get = (account: string): string | null => {
    const r = run('/usr/bin/security', ['find-generic-password', '-a', checkAccount(account), '-s', SERVICE, '-w'], { timeoutMs: READ_TIMEOUT_MS });
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
      if (r.status !== 0) throw new Error(`${label}: ${firstLine(scrub(r.stderr, [secret])) || `security exited ${String(r.status)}`}`);
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
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { timeoutMs: READ_TIMEOUT_MS });
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
      if (r.status !== 0) throw new Error(`secret-tool: ${firstLine(scrub(r.stderr, [secret])) || `exited ${String(r.status)}`}`);
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

/**
 * PowerShell by absolute path under the system folder, never by bare name: Windows searches the current directory before PATH,
 * so a `powershell.exe` dropped in a repo would run with every token this process handles.
 */
export function powershellPath(env: Readonly<Record<string, string | undefined>>): string {
  const root = env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsBackend(run: Run, blobFile: string, env: Readonly<Record<string, string | undefined>>): TokenBackend {
  const label = 'Windows DPAPI (encrypted for your Windows account)';
  const exe = powershellPath(env);
  const ps = (script: string, input?: string, timeoutMs?: number): RunResult =>
    run(exe, [...PS_ARGS, script], input === undefined && timeoutMs === undefined ? undefined : { ...(input === undefined ? {} : { input }), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const readBlobs = (): Record<string, string> => {
    let text: string;
    try {
      text = fs.readFileSync(blobFile, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return {};
      throw new Error(`could not read ${blobFile}: ${(e as Error).message}`);
    }
    // A file that does not parse is NOT an empty file. Treating it as one would read every source as disconnected, and the next write
    // would replace it with one entry. It is left exactly as it is, and every read and write against it fails loudly.
    try {
      const v = JSON.parse(text) as unknown;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
    } catch { /* falls through to the one error */ }
    throw new Error(`${blobFile} is not valid JSON, so the tokens in it cannot be read. It was left untouched: restore it from a backup, or delete it and reconnect your sources`);
  };
  const writeBlobs = (blobs: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(blobFile), { recursive: true });
    // Temp file in the same folder, then rename: a crash leaves the old file or the new one, never half of one.
    const tmp = `${blobFile}.${String(process.pid)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(blobs), { mode: 0o600 });
      fs.renameSync(tmp, blobFile);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      throw e;
    }
  };
  const get = (account: string): string | null => {
    const blob = readBlobs()[checkAccount(account)];
    if (blob === undefined) return null;
    const r = ps(PS_UNPROTECT, blob, READ_TIMEOUT_MS);
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
      if (r.status !== 0 || blob === '') throw new Error(`DPAPI: ${firstLine(scrub(r.stderr, [secret])) || 'did not produce an encrypted value'}`);
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
  /** The environment PowerShell's folder is read from (SystemRoot). Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

export function selectBackend(o: SelectOptions): Selection {
  if (o.mode === 'file') return { backend: null, label: 'the config file', reason: 'ALIGN_TOKEN_STORE=file', forced: true };
  let backend: TokenBackend | null = null;
  if (o.platform === 'darwin') backend = macBackend(o.run);
  else if (o.platform === 'linux') backend = libsecretBackend(o.run);
  else if (o.platform === 'win32') backend = windowsBackend(o.run, o.blobFile ?? 'align-token-blobs.json', o.env ?? process.env);
  if (backend === null) return { backend: null, label: 'an OS credential store', reason: `no credential store is supported on ${o.platform}`, forced: false };
  const problem = backend.probe();
  if (problem !== null) return { backend: null, label: backend.label, reason: problem, forced: false };
  return { backend, label: backend.label, reason: null, forced: false };
}

export type WriteResult = { store: 'keychain'; label: string } | { store: 'file'; reason: string };
/** A failed read is not an absent one: "not connected" may only be concluded from `absent`. */
export type ReadResult = { status: 'found'; value: string } | { status: 'absent' } | { status: 'failed'; reason: string };

export interface TokenVault {
  /**
   * The secret from the OS store. `expected` says the config recorded one there: with no usable store that is a failed read, because
   * the token exists and cannot be reached, and reading it as absent would mark a connected source as not connected.
   */
  read(account: string, expected?: boolean): ReadResult;
  /** To the OS store, verified. 'file' means the caller must keep the secret in the config file, and has been told why. */
  write(account: string, secret: string): WriteResult;
  /** Like write, for a secret already on disk: true only when the OS store verifiably holds it. Silent, and tried once per account per process. */
  migrate(account: string, secret: string): boolean;
  /** 'no-store': there is nothing to ask. 'failed': there is a store and it could not remove it (or already failed this process). */
  remove(account: string): 'removed' | 'no-store' | 'failed';
  describe(): { store: 'keychain' | 'file'; label: string; reason: string | null; forced: boolean };
}

export interface VaultOptions {
  selection: Selection | (() => Selection);
  /** Told once when a write falls back to the file, and once when a read fails. */
  notify?: (message: string) => void;
  now?: () => number;
}

const READ_TTL_MS = 5_000;

export function createTokenVault(o: VaultOptions): TokenVault {
  let chosen: Selection | undefined;
  const sel = (): Selection => (chosen ??= typeof o.selection === 'function' ? o.selection() : o.selection);
  const now = o.now ?? Date.now;
  let notifiedWrite = false;
  let notifiedRead = false;
  // The first time the store errors or times out it is switched off for the rest of the process. A locked keychain that takes seconds
  // to answer would otherwise cost that wait on every read, in every command and on every turn of the MCP loop.
  let dead: string | null = null;
  const migrated = new Set<string>();
  // Only hits are cached, briefly: a miss must stay a live question, because another `align` process may save the token a moment later.
  const hits = new Map<string, { value: string; at: number }>();

  const fallback = (reason: string): WriteResult => {
    const s = sel();
    if (!s.forced && !notifiedWrite) {
      notifiedWrite = true;
      o.notify?.(
        `Align could not use ${s.label}: ${reason}. ` +
        'Saving connector tokens in its config file instead (owner-only, mode 0600). Run `align doctor` to see which store is in use.',
      );
    }
    return { store: 'file', reason };
  };
  const failedRead = (reason: string): ReadResult => {
    if (!notifiedRead) {
      notifiedRead = true;
      o.notify?.(`Align could not read ${sel().label}: ${reason}. Tokens saved there are unavailable for now, so those sources are skipped rather than treated as disconnected. Run \`align doctor\` to see which store is in use.`);
    }
    return { status: 'failed', reason };
  };
  const kill = (e: unknown, secret?: string): string => {
    const raw = e instanceof Error ? e.message : String(e);
    dead = secret === undefined ? raw : scrub(raw, [secret]);
    return dead;
  };

  return {
    read(account, expected = false) {
      const s = sel();
      if (s.backend === null) return expected ? failedRead(s.reason ?? 'no credential store') : { status: 'absent' };
      if (dead !== null) return { status: 'failed', reason: dead };
      const hit = hits.get(account);
      if (hit && now() - hit.at < READ_TTL_MS) return { status: 'found', value: hit.value };
      try {
        const v = s.backend.get(account);
        if (v === null) { hits.delete(account); return { status: 'absent' }; }
        hits.set(account, { value: v, at: now() });
        return { status: 'found', value: v };
      } catch (e) { return failedRead(kill(e)); }
    },
    write(account, secret) {
      const s = sel();
      hits.delete(account);
      if (s.backend === null) return fallback(s.reason ?? 'no credential store');
      if (dead !== null) return fallback(dead);
      try {
        s.backend.set(account, secret);
        hits.set(account, { value: secret, at: now() });
        return { store: 'keychain', label: s.backend.label };
      } catch (e) {
        return fallback(kill(e, secret));
      }
    },
    migrate(account, secret) {
      const s = sel();
      hits.delete(account);
      if (s.backend === null || dead !== null || migrated.has(account)) return false;
      migrated.add(account);
      try { s.backend.set(account, secret); hits.set(account, { value: secret, at: now() }); return true; } catch (e) { kill(e, secret); return false; }
    },
    remove(account) {
      const s = sel();
      hits.delete(account);
      if (s.backend === null) return 'no-store';
      if (dead !== null) return 'failed';
      try { s.backend.remove(account); return 'removed'; } catch (e) { kill(e); return 'failed'; }
    },
    describe() {
      const s = sel();
      return s.backend ? { store: 'keychain', label: s.backend.label, reason: dead, forced: false } : { store: 'file', label: 'the config file', reason: s.reason, forced: s.forced };
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
