import envPaths from 'env-paths';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * $XDG_CACHE_HOME/align-cli/launch, honoured on every platform; else the OS cache dir.
 * The XDG spec says a relative XDG_CACHE_HOME is invalid and must be ignored.
 */
export function launchCacheDir(env: Record<string, string | undefined>): string {
  const xdg = env['XDG_CACHE_HOME'];
  return path.join(xdg && path.isAbsolute(xdg) ? path.join(xdg, 'align-cli') : defaultCacheDir(), 'launch');
}

/**
 * env-paths reads process.env.XDG_CACHE_HOME itself and would hand a relative value straight
 * back, so the variable is hidden from it for this one synchronous call.
 */
function defaultCacheDir(): string {
  const saved = process.env['XDG_CACHE_HOME'];
  delete process.env['XDG_CACHE_HOME'];
  try {
    return envPaths('align-cli', { suffix: '' }).cache;
  } finally {
    if (saved !== undefined) process.env['XDG_CACHE_HOME'] = saved;
  }
}

/**
 * Write `content` only when it differs from what is there, via a temp file and rename so a
 * reader (the agent starting up) never sees a half-written file. Returns whether it wrote.
 * The dir is created 0700 and refused if another user owns it: these files name commands
 * the agent will run, so a dir someone else controls is a way to run theirs.
 */
export function writeIfChanged(dir: string, name: string, content: string, opts: { uid?: number; mode?: number } = {}): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = 'uid' in opts ? opts.uid : process.getuid?.();
  const posix = process.platform !== 'win32';
  const st = statSync(dir);
  if (uid !== undefined && posix && st.uid !== uid) {
    throw new Error(`${dir} is owned by another user; refusing to use it for launch files`);
  }
  // A dir made before mkdir's 0700 (or by hand) can be looser; it is ours, so tighten it.
  if (posix && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  const target = path.join(dir, name);
  // A name may carry sub-directories (OpenCode loads plugins/align.js from a config dir).
  const targetDir = path.dirname(target);
  if (targetDir !== dir) mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  try {
    // Only a regular file counts as up to date: a link here (planted, or left by hand) is replaced.
    if (lstatSync(target).isFile() && readFileSync(target, 'utf8') === content) {
      if (opts.mode !== undefined && posix && (statSync(target).mode & 0o777) !== opts.mode) chmodSync(target, opts.mode);
      return false;
    }
  } catch {
    // missing: write it
  }
  const tmp = path.join(targetDir, `.${path.basename(name)}.${process.pid}.tmp`);
  // Never through whatever sits at the temp path: create it exclusively (wx), with the mode from
  // the first byte (a umask only removes bits). Something already there (a crashed launch's
  // leftover, or a planted link) is removed, not followed, and the exclusive create is retried.
  const create = (): void => writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', ...(opts.mode === undefined ? {} : { mode: opts.mode }) });
  try {
    create();
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e;
    rmSync(tmp, { force: true });
    create();
  }
  renameSync(tmp, target);
  return true;
}

/** Remove every launch file named `<prefix>...` except `keep` (all of them with no keep). A missing dir is fine. */
export function pruneLaunchFiles(dir: string, prefix: string, keep?: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (n.startsWith(prefix) && n !== keep) rmSync(path.join(dir, n), { force: true });
}
