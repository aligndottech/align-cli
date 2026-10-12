/**
 * Owner-only files and directories for what align keeps on this machine: the local graph (its
 * database and the -wal/-shm sidecars), the config directory, and the state and cache files.
 *
 * Two halves, because either alone leaves a gap:
 * - ON CREATE: directories are made 0700 and files 0600. A umask can only remove bits, so this
 *   never starts out wider than owner-only.
 * - ON EVERY OPEN: an existing path is re-checked and any group or world bit is removed. A graph
 *   written by an older version (SQLite creates files 0644), a directory made by `conf`
 *   (0755), or a file someone copied in with `cp` is tightened the next time align touches it.
 *   Owner bits are kept as they are: this only ever narrows a mode, it never widens one.
 *
 * Windows has no mode bits (Node's chmod there only flips the read-only flag), so nothing is
 * chmodded on it. The files live under the user's profile (%APPDATA%, %LOCALAPPDATA%), whose
 * default ACL already limits them to the user, SYSTEM and Administrators. Setting an explicit
 * owner-only ACL would mean shelling out to icacls on every open, which is slow and easy to get
 * wrong, so it is documented instead (docs/local-mode.md, SECURITY.md).
 *
 * Best effort by design: a chmod that fails (a directory owned by another user, a read-only
 * filesystem) is not a reason to refuse to open the user's own graph.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The graph is one logical database spread over three files: the DB itself plus the WAL sidecars
 * SQLite maintains under `PRAGMA journal_mode = WAL` (local-db.ts). One writer of that fact:
 * local-mode.ts re-exports it as LOCAL_DB_SUFFIXES for relocate and reset.
 */
export const GRAPH_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;

export interface PrivateFileDeps {
  /** True where mode bits mean something. Default: the platform has getuid (macOS, Linux). */
  posix?: boolean;
  chmod?: (p: string, mode: number) => void;
  /** The mode bits of `p` (permissions plus setuid/setgid/sticky), or undefined when it does not exist. */
  modeOf?: (p: string) => number | undefined;
}

const isPosix = (): boolean => typeof process.getuid === 'function';

function statMode(p: string): number | undefined {
  try { return fs.statSync(p).mode & 0o7777; } catch { return undefined; }
}

/** Remove the group and world bits from `p` when it has any. Never adds a bit; setgid and sticky are kept. */
function narrow(p: string, deps: PrivateFileDeps): void {
  if (!(deps.posix ?? isPosix())) return;
  const m = (deps.modeOf ?? statMode)(p);
  if (m === undefined || (m & 0o077) === 0) return;
  try { (deps.chmod ?? fs.chmodSync)(p, m & ~0o077); } catch { /* best effort, see the header */ }
}

/** Create `dir` (and any missing parents) 0700, and tighten it if it already existed wider. False when it cannot be created. */
export function ensurePrivateDir(dir: string, deps: PrivateFileDeps = {}): boolean {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  narrow(dir, deps);
  return true;
}

/** Tighten an existing file to owner-only. A missing file is not an error. */
export function tightenFile(file: string, deps: PrivateFileDeps = {}): void {
  narrow(file, deps);
}

/** The graph database and its -wal/-shm sidecars, each tightened when present. */
export function tightenGraphFiles(dbPath: string, deps: PrivateFileDeps = {}): void {
  if (dbPath === '' || dbPath === ':memory:') return;
  for (const s of GRAPH_FILE_SUFFIXES) narrow(`${dbPath}${s}`, deps);
}

/**
 * Create an empty graph file 0600 before SQLite opens it, so the very first byte is never
 * world-readable (SQLite's own default for a new file is 0644). An existing file is left alone.
 */
export function precreatePrivateFile(file: string): void {
  try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch { /* exists already, or SQLite reports the real error */ }
}

/** writeFileSync, but the result is 0600 whether the file was new or not (its `mode` option only applies on create). */
export function writePrivateFile(file: string, data: string | Uint8Array): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  narrow(file, {});
}


/**
 * The folder align manages for its config and the local graph (env-paths, `suffix: ''`, the same call `conf`
 * makes). Only this folder is narrowed when the graph opens: a graph somewhere else (a snapshot, a hand-set
 * `localDbPath`) sits in a folder that is not ours to chmod, such as a repo or the home folder.
 */
/**
 * The one folder align keeps its config and its local graph in: ~/.align (ALI-1622). One place a user
 * can find, back up or delete, like ~/.claude and ~/.codex. Older installs kept these under the OS config
 * directory; index.ts copies them here once at startup (migrateConfigDirectory, migrateLocalDb).
 */
export function alignConfigDir(): string {
  return path.join(os.homedir(), '.align');
}
