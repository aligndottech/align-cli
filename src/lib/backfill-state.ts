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

/** The directory, created private, or null when it cannot be (or is a symlink someone planted). */
export function backfillDir(): string | null {
  try {
    const dir = path.join(stateHome(), 'align-cli', 'backfill');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    return dir;
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

export function liveBackfills(dir: string, alive: (pid: number) => boolean = pidAlive): BackfillStatus[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names
    .map((n) => readStatus(path.join(dir, n)))
    .filter((s): s is BackfillStatus => s !== null && s.state === 'running' && alive(s.pid));
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

/**
 * Start the child detached and wait up to ~300 ms for the OS to confirm it exists. "Started" is
 * claimed only on that confirmation: a spawn that fails asynchronously (ENOENT, EMFILE) arrives as
 * an 'error' event, and stdio is ignored, so nothing else would ever say.
 */
export function startBackfillChild(
  source: string,
  argv: string[],
  file: string,
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
        env: { ...process.env, [BACKFILL_STATUS_ENV]: file },
      });
    } catch {
      return done({ ok: false });
    }
    const confirm = (): void => {
      const pid = child.pid;
      if (pid === undefined) return done({ ok: false });
      try {
        writeStatus(file, { source, pid, started_at: new Date().toISOString(), state: 'running' });
      } catch { /* the child still runs; only the cap loses sight of it */ }
      child.unref();
      done({ ok: true, pid });
    };
    child.on('error', () => done({ ok: false }));
    child.on('spawn', confirm);
    setTimeout(() => { if (!settled) (child.pid !== undefined ? confirm : () => done({ ok: false }))(); }, START_CONFIRM_MS).unref();
  });
}

/**
 * The child's side. Reads the status path from the environment, but only trusts one inside the
 * backfill directory: the variable is not a way to make this process overwrite another file.
 * Writes `running` now and the final state at exit (the exit code, and the last line it noted).
 */
export function trackChildFromEnv(
  env: Record<string, string | undefined> = process.env,
): { note(line: string): void } | null {
  const file = env[BACKFILL_STATUS_ENV];
  const dir = backfillDir();
  if (!file || !dir) return null;
  if (path.resolve(path.dirname(file)) !== path.resolve(dir) || !file.endsWith('.json')) return null;
  const source = path.basename(file, '.json');
  const started_at = readStatus(file)?.started_at ?? new Date().toISOString();
  let last: string | undefined;
  try { writeStatus(file, { source, pid: process.pid, started_at, state: 'running' }); } catch { return null; }
  process.on('exit', (code) => {
    try {
      writeStatus(file, {
        source, pid: process.pid, started_at, state: code === 0 ? 'done' : 'failed',
        finished_at: new Date().toISOString(), exit_code: code, ...(last !== undefined ? { last_line: last.slice(0, 200) } : {}),
      });
    } catch { /* nothing to report to */ }
  });
  return { note: (line) => { last = line; } };
}
