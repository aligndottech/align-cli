import fs from 'node:fs';
import path from 'node:path';

/**
 * The XDG base-directory variables. The XDG spec says a relative value is invalid and must be
 * ignored. It matters beyond correctness: an agent that loads a repo's `.env` (cn, Cline) hands
 * its MCP children whatever that file says, and XDG_CONFIG_HOME=./evilcfg once made
 * `align mcp --env local` copy the user's local.db into the repo. One helper, used everywhere.
 */
export const XDG_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const;
export type XdgVar = (typeof XDG_VARS)[number];

/**
 * A path under /proc or /dev/fd names another process's view of the filesystem (`/proc/self/cwd`
 * is whatever directory the reader runs in): never a real config home.
 */
export function procLike(p: string): boolean {
  return /^\/(proc|dev\/fd)(\/|$)/.test(p);
}

/**
 * The real path of `p`: its nearest existing ancestor resolved through symlinks, plus the rest.
 * A path that does not exist yet still resolves through the links above it.
 */
export function realPathOf(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  for (let dir = abs; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      if (path.dirname(dir) === dir) return abs;
      rest.push(path.basename(dir));
    }
  }
}

/** The variable's value only when it is an absolute path outside /proc and /dev/fd; otherwise undefined. */
export function absoluteXdg(env: Record<string, string | undefined>, name: XdgVar | string): string | undefined {
  const v = env[name];
  return v && path.isAbsolute(v) && !procLike(v) && !procLike(realPathOf(v)) ? v : undefined;
}

/**
 * Delete every relative XDG_* (and any under /proc or /dev/fd) from `env` (process.env at startup, before anything reads it:
 * `conf` and env-paths read these themselves). An empty value is left alone, as it already
 * means unset. Returns the names removed.
 */
export function dropRelativeXdg(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const name of XDG_VARS) {
    const v = env[name];
    if (v && (!path.isAbsolute(v) || procLike(v) || procLike(realPathOf(v)))) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
