/**
 * L3: the on-disk record of `align_backfill` children, so the tool can cap them and `align_sync`
 * (L5) can find them later. One small JSON file per source under
 * `$XDG_STATE_HOME/align-cli/backfill/<source>.json` (default ~/.local/state; %LOCALAPPDATA% on
 * Windows). Written by the parent when the child has started and by the child when it ends.
 *
 * Caps: at most one running child per source and three in all. "Running" means the file says so
 * AND the pid is alive: a child that was killed leaves a file behind, and that must not block
 * the next backfill. A pid can be reused, so a finished file is never counted as running.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alignDistribution } from './distribution.js';
import { absoluteXdg } from './xdg.js';

export const BACKFILL_STATUS_ENV = 'ALIGN_BACKFILL_STATUS';
export const MAX_PER_SOURCE = 1;
export const MAX_TOTAL = 3;
/** How long the parent waits for the OS to confirm the child exists before saying it could not start. */
const START_CONFIRM_MS = 300;

export interface BackfillStatus {
  source: string;
  pid: number;
  started_at: string;
  state: 'running' | 'done' | 'failed';
  finished_at?: string;
  exit_code?: number;
  last_line?: string;
}

function stateHome(): string {
  const xdg = absoluteXdg(process.env, 'XDG_STATE_HOME');
  if (xdg) return xdg;
  if (process.platform === 'win32') return process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(os.homedir(), '.local', 'state');
}

/** One directory of the chain: a real directory (never a link someone planted), ours, private. */
function ensureOwnPrivateDir(d: string): boolean {
  try {
    let st = fs.lstatSync(d, { throwIfNoEntry: false });
    if (!st) {
      fs.mkdirSync(d, { mode: 0o700 });
      st = fs.lstatSync(d);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function') {
      if (st.uid !== process.getuid()) return false;
      // Ours but open to the group or the world: tighten it. If that fails, do not trust it.
      if ((st.mode & 0o077) !== 0) fs.chmodSync(d, 0o700);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The directory, created private, or null when anything BELOW the state home is not ours and
 * private: `align-cli` and `backfill` are each checked with lstat before anything is created
 * inside them, so a symlink planted at either is refused instead of written through. (The state
 * home itself is the user's own choice and may legitimately sit behind links, as /var does on macOS.)
 */
export function backfillDir(): string | null {
  try {
    const base = alignStateDir();
    if (base === null) return null;
    const dir = path.join(base, 'backfill');
    return ensureOwnPrivateDir(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** `<state home>/align-cli`, created private and checked with lstat (L5: the sync lock and the
 *  launch summary live beside `backfill/`, and share its refusal of a planted link), or null. */
export function alignStateDir(): string | null {
  try {
    const home = stateHome();
    fs.mkdirSync(home, { recursive: true });
    const base = path.join(home, 'align-cli');
    return ensureOwnPrivateDir(base) ? base : null;
  } catch {
    return null;
  }
}

export function statusPath(dir: string, source: string): string {
  return path.join(dir, `${source}.json`);
}

export function readStatus(file: string): BackfillStatus | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BackfillStatus>;
    if (typeof raw.source !== 'string' || !Number.isInteger(raw.pid) || typeof raw.started_at !== 'string') return null;
    if (raw.state !== 'running' && raw.state !== 'done' && raw.state !== 'failed') return null;
    return raw as BackfillStatus;
  } catch {
    return null;
  }
}

/** Atomic (write a sibling, rename over): a reader never sees half a file. */
export function writeStatus(file: string, status: BackfillStatus): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Is this process alive? EPERM means it exists and is not ours, which is alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** A "running" file older than this is a leftover (SIGKILL, OOM, reboot), whatever its pid says now:
 *  pids are reused, and a backfill that has run for a day is not running. */
const STALE_RUNNING_MS = 24 * 3_600_000;

export function liveBackfills(dir: string, alive: (pid: number) => boolean = pidAlive): BackfillStatus[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names
    .map((n) => readStatus(path.join(dir, n)))
    .filter((s): s is BackfillStatus => s !== null && s.state === 'running' && !isStale(s) && alive(s.pid));
}

function isStale(s: BackfillStatus): boolean {
  const started = Date.parse(s.started_at);
  return Number.isNaN(started) || Date.now() - started > STALE_RUNNING_MS;
}

export function admit(
  live: BackfillStatus[],
  source: string,
): { ok: true } | { ok: false; reason: 'source' | 'total'; running: BackfillStatus[] } {
  const same = live.filter((s) => s.source === source);
  if (same.length >= MAX_PER_SOURCE) return { ok: false, reason: 'source', running: same };
  if (live.length >= MAX_TOTAL) return { ok: false, reason: 'total', running: live };
  return { ok: true };
}

/** Sources whose slot THIS process has taken and not yet handed over to a status file. MCP does not
 *  queue requests, so five tool calls can be in flight at once; the check and the take happen in
 *  one synchronous stretch, before any await, or all five pass. */
const reservedHere = new Set<string>();
/** A placeholder older than this, or whose process is gone, is a leftover. */
const LOCK_FRESH_MS = 60_000;

export type Reservation =
  | { ok: true; release(): void }
  | { ok: false; reason: 'source' | 'total'; running: BackfillStatus[] }
  /** The state directory could not be used safely, so no slot can be recorded: nothing starts. */
  | { ok: false; reason: 'state'; running: [] };

function lockHolderActive(file: string, alive: (pid: number) => boolean): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; at?: number };
    return typeof raw.pid === 'number' && typeof raw.at === 'number' && Date.now() - raw.at < LOCK_FRESH_MS && alive(raw.pid);
  } catch {
    return false;
  }
}

/**
 * Take a slot for `source`, SYNCHRONOUSLY (no await anywhere in here). Counts what is running
 * (status files), what this process has reserved, and what other server processes have reserved
 * (placeholder `<source>.lock` files made with O_EXCL, so two processes cannot both pass). The
 * caller releases it once the child is confirmed (its status file then holds the slot) or has
 * failed to start.
 */
export function reserveSlot(dir: string, source: string, alive: (pid: number) => boolean = pidAlive): Reservation {
  const lock = path.join(dir, `${source}.lock`);
  const held = new Map<string, BackfillStatus>();
  for (const s of liveBackfills(dir, alive)) held.set(s.source, s);
  for (const r of reservedHere) held.set(r, held.get(r) ?? { source: r, pid: process.pid, started_at: new Date().toISOString(), state: 'running' });
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.lock')) continue;
      const src = n.slice(0, -'.lock'.length);
      if (lockHolderActive(path.join(dir, n), alive)) held.set(src, held.get(src) ?? { source: src, pid: 0, started_at: new Date().toISOString(), state: 'running' });
    }
  } catch { /* an unreadable directory counts as empty; the exclusive create below still decides */ }
  const admission = admit([...held.values()], source);
  if (!admission.ok) return admission;
  const take = (): boolean => {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') return true; // cannot make the file: the in-process set still holds
      return false;
    }
  };
  if (!take()) {
    if (lockHolderActive(lock, alive)) return { ok: false, reason: 'source', running: [held.get(source) ?? { source, pid: 0, started_at: new Date().toISOString(), state: 'running' }] };
    try { fs.unlinkSync(lock); } catch { /* raced with another process's cleanup */ }
    if (!take()) return { ok: false, reason: 'source', running: [] };
  }
  reservedHere.add(source);
  return {
    ok: true,
    release: () => {
      reservedHere.delete(source);
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    },
  };
}

/**
 * How to start `align <argv>` as a child. An npm install runs `node <entry> ...`. A compiled
 * binary (`bun build --compile`) has a bunfs path in argv[1], which is not a user argument, so
 * the child is the executable with the arguments directly (alignDistribution() is decided at
 * build time, not sniffed).
 */
export function backfillChildCommand(
  argv: string[],
  o: { dist?: 'npm' | 'binary'; execPath?: string; argv1?: string | undefined } = {},
): { command: string; args: string[] } {
  const dist = o.dist ?? alignDistribution();
  const execPath = o.execPath ?? process.execPath;
  if (dist === 'binary') return { command: execPath, args: argv };
  const argv1 = 'argv1' in o ? o.argv1 : process.argv[1];
  return { command: execPath, args: [argv1 ?? 'align', ...argv] };
}

function withoutStatusEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { [BACKFILL_STATUS_ENV]: _drop, ...rest } = env;
  return rest;
}

/**
 * Start the child detached and wait up to ~300 ms for the OS to confirm it exists. "Started" is
 * claimed only on that confirmation: a spawn that fails asynchronously (ENOENT, EMFILE) arrives as
 * an 'error' event, and stdio is ignored, so nothing else would ever say.
 */
/** Set on every child an agent's tool call starts, so what the child writes can be attributed to the agent (scope-connect.ts `startedByAgent`). */
export const STARTED_BY_AGENT_ENV = 'ALIGN_STARTED_BY';

export function startBackfillChild(
  source: string,
  argv: string[],
  file: string | undefined,
  cmd: { command: string; args: string[] } = backfillChildCommand(argv),
): Promise<{ ok: boolean; pid?: number }> {
  const { command, args } = cmd;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; pid?: number }) => { if (!settled) { settled = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // L5: a sync child has no status file (the sync lock and source_sync record it), so it must
        // not inherit one from this process either.
        env: { ...(file === undefined ? withoutStatusEnv(process.env) : { ...process.env, [BACKFILL_STATUS_ENV]: file }), [STARTED_BY_AGENT_ENV]: 'mcp' },
      });
    } catch {
      return done({ ok: false });
    }
    const confirm = (): void => {
      const pid = child.pid;
      if (pid === undefined) return done({ ok: false });
      try {
        if (file !== undefined) writeStatus(file, { source, pid, started_at: new Date().toISOString(), state: 'running' });
      } catch { /* the child still runs; only the cap loses sight of it */ }
      child.unref();
      done({ ok: true, pid });
    };
    child.on('error', () => done({ ok: false }));
    child.on('spawn', confirm);
    setTimeout(() => { if (!settled) (child.pid !== undefined ? confirm : () => done({ ok: false }))(); }, START_CONFIRM_MS).unref();
  });
}

export interface ChildTrack {
  /** The last thing worth knowing about this run; written into the final status. */
  note(line: string): void;
  /** Write the final state now (idempotent; also runs at process exit). */
  finish(code: number): void;
}
const tracks = new Map<string, ChildTrack>();

/**
 * The child's side. Reads the status path from the environment, but only trusts one inside the
 * backfill directory: the variable is not a way to make this process overwrite another file.
 * Writes `running` now and the final state at exit (the exit code, and the last line it noted).
 * Called at the very top of the entry point (startup-backfill-track.ts) so a run that dies before
 * any command code - a bad flag, a parse error - still records that it failed. Memoised per file.
 */
export function trackChildFromEnv(
  env: Record<string, string | undefined> = process.env,
): ChildTrack | null {
  const file = env[BACKFILL_STATUS_ENV];
  const dir = backfillDir();
  if (!file || !dir) return null;
  if (path.resolve(path.dirname(file)) !== path.resolve(dir) || !file.endsWith('.json')) return null;
  const known = tracks.get(file);
  if (known) return known;
  const source = path.basename(file, '.json');
  const started_at = readStatus(file)?.started_at ?? new Date().toISOString();
  let last: string | undefined;
  try { writeStatus(file, { source, pid: process.pid, started_at, state: 'running' }); } catch { return null; }
  const finish = (code: number): void => {
    try {
      writeStatus(file, {
        source, pid: process.pid, started_at, state: code === 0 ? 'done' : 'failed',
        finished_at: new Date().toISOString(), exit_code: code, ...(last !== undefined ? { last_line: last.slice(0, 200) } : {}),
      });
    } catch { /* nothing to report to */ }
  };
  process.on('exit', (code) => finish(code));
  const track: ChildTrack = { note: (line) => { last = line; }, finish };
  tracks.set(file, track);
  return track;
}
