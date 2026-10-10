import path from 'node:path';

/**
 * The XDG base-directory variables. The XDG spec says a relative value is invalid and must be
 * ignored. It matters beyond correctness: an agent that loads a repo's `.env` (cn, Cline) hands
 * its MCP children whatever that file says, and XDG_CONFIG_HOME=./evilcfg once made
 * `align mcp --env local` copy the user's local.db into the repo. One helper, used everywhere.
 */
export const XDG_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const;
export type XdgVar = (typeof XDG_VARS)[number];

/** The variable's value only when it is an absolute path; otherwise undefined. */
export function absoluteXdg(env: Record<string, string | undefined>, name: XdgVar | string): string | undefined {
  const v = env[name];
  return v && path.isAbsolute(v) ? v : undefined;
}

/**
 * Delete every relative XDG_* from `env` (process.env at startup, before anything reads it:
 * `conf` and env-paths read these themselves). An empty value is left alone, as it already
 * means unset. Returns the names removed.
 */
export function dropRelativeXdg(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const name of XDG_VARS) {
    const v = env[name];
    if (v && !path.isAbsolute(v)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
