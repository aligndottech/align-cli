import envPaths from 'env-paths';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
export function writeIfChanged(dir: string, name: string, content: string, opts: { uid?: number } = {}): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = 'uid' in opts ? opts.uid : process.getuid?.();
  if (uid !== undefined && process.platform !== 'win32' && statSync(dir).uid !== uid) {
    throw new Error(`${dir} is owned by another user; refusing to use it for launch files`);
  }
  const target = path.join(dir, name);
  try {
    if (readFileSync(target, 'utf8') === content) return false;
  } catch {
    // missing: write it
  }
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, target);
  return true;
}
