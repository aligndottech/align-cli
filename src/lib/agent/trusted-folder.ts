import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Has the user already accepted Claude Code's trust prompt for this folder? Claude Code records it
 * in its global config as `projects[<absolute path>].hasTrustDialogAccepted`. That file is
 * `$CLAUDE_CONFIG_DIR/.claude.json` when the variable is set and non-empty, else `~/.claude.json`
 * (read from the installed Claude Code 2.1.322: `join(CLAUDE_CONFIG_DIR || home, '.claude.json')`).
 * When the variable is set the home file is never read, so a stale legacy file cannot grant trust
 * Claude no longer grants. We borrow the answer so a repo the user trusts there gets its own
 * settings and skills here, and any other repo stays locked down.
 *
 * Fails CLOSED: a missing, unreadable or malformed file, or a value that is not exactly `true`, all
 * mean "not trusted". Claude Code also counts a trusted parent, but only up to the repository root,
 * so this checks the folder and each parent up to the nearest directory holding `.git` (a folder or
 * a file). With no `.git` above, the folder alone. The home directory and the filesystem root never
 * count, since Claude does not record a persistent trust for them.
 */
const real = (p: string): string | undefined => {
  try { return realpathSync(p); } catch { return undefined; }
};

function repoChain(cwd: string): string[] {
  const start = real(cwd);
  if (start === undefined) return [];
  const chain: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (existsSync(path.join(dir, '.git'))) return chain;
    if (path.dirname(dir) === dir) return [start];
  }
}

/** The nearest ancestor of `cwd` holding `.git`; `cwd` itself when there is none. */
export function repoRoot(cwd: string): string {
  const chain = repoChain(cwd);
  return chain.length === 0 ? cwd : chain[chain.length - 1]!;
}

/** Does the repo root carry harness content a trusted session would load? */
export function repoHasHarness(cwd: string): boolean {
  const root = repoRoot(cwd);
  return ['.claude', '.agents', '.pi'].some((d) => existsSync(path.join(root, d)));
}

/** The folder whose trust Claude Code recorded (the folder or a parent up to the repo root), or undefined. */
export function trustedDir(cwd: string, home: string, env: Record<string, string | undefined>): string | undefined {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  const file = path.join(configDir !== undefined && configDir !== '' ? configDir : home, '.claude.json');
  let projects: unknown;
  try {
    projects = (JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown } | null)?.projects;
  } catch {
    return undefined;
  }
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return undefined;
  const trusted = new Set<string>();
  for (const [key, entry] of Object.entries(projects as Record<string, unknown>)) {
    if ((entry as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted !== true) continue;
    trusted.add(real(key) ?? key);
  }
  const never = new Set([real(home) ?? home, path.parse(cwd).root]);
  return repoChain(cwd).find((dir) => !never.has(dir) && dir !== path.parse(dir).root && trusted.has(dir));
}
