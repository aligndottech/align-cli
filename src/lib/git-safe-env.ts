/**
 * Git starts the program a repository's `core.fsmonitor` names on status, diff and blame. A clone
 * does not carry `.git/config`, but a repo that arrived with its `.git` folder can, and the edit
 * hook reads whatever repo the agent is in. Git reads extra config from the environment (2.31 and
 * later), above the repository's own, so one setting here covers every git call this process and
 * its children make. An older git ignores it and behaves as before.
 *
 * It does not cover a text converter or an external diff program: those have no single key, so the
 * diff and blame calls pass `--no-textconv` and `--no-ext-diff` themselves.
 */
export function hardenGitEnv(env: Record<string, string | undefined> = process.env): void {
  // Git reads the count the way strtol does: leading spaces and a sign are fine, and empty is zero.
  // Anything else it refuses. That is the caller's to see, so nothing is written over it.
  const raw = /^\s*([+-]?\d+)?$/.exec(env['GIT_CONFIG_COUNT'] ?? '');
  const count = raw ? Number(raw[1] ?? '0') : NaN;
  if (!Number.isInteger(count) || count < 0) return;
  // Git takes the last value for a key, so only the last entry says whether the watcher is already off.
  let off = false;
  for (let i = 0; i < count; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === 'core.fsmonitor') off = env[`GIT_CONFIG_VALUE_${i}`] === 'false';
  }
  if (off) return;
  env[`GIT_CONFIG_KEY_${count}`] = 'core.fsmonitor';
  env[`GIT_CONFIG_VALUE_${count}`] = 'false';
  env['GIT_CONFIG_COUNT'] = String(count + 1);
}

/**
 * For `git diff`: no text converter and no external diff program, whatever the repository's config names.
 * `--submodule=short` keeps git from running a second diff inside a changed submodule (`diff.submodule=diff`),
 * which would take its settings from the submodule's own config and ignore the two flags before it.
 */
export const PLAIN_DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--submodule=short'] as const;

/** The environment keys git reads extra config from. */
export const GIT_ENV_CONFIG_KEY = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
