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
  const parsed = Number(env['GIT_CONFIG_COUNT'] ?? '0');
  const count = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  for (let i = 0; i < count; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === 'core.fsmonitor' && env[`GIT_CONFIG_VALUE_${i}`] === 'false') return;
  }
  env[`GIT_CONFIG_KEY_${count}`] = 'core.fsmonitor';
  env[`GIT_CONFIG_VALUE_${count}`] = 'false';
  env['GIT_CONFIG_COUNT'] = String(count + 1);
}

/** For `git diff`: no text converter and no external diff program, whatever the repository's config names. */
export const PLAIN_DIFF_ARGS = ['--no-ext-diff', '--no-textconv'] as const;
