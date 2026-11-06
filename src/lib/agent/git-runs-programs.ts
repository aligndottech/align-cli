import { execFile } from 'node:child_process';

/**
 * Git runs a program for some read commands when the repository's own config names one:
 * `core.fsmonitor` on status and diff, a `textconv` or external diff driver on diff, show and log,
 * and anything pulled in through `include`. A clone does not carry `.git/config`, so a hostile
 * repo cannot set these, but a repo that arrived with its `.git` folder can. The user's own global
 * config is theirs to trust, so only the repository's config is read.
 */
const RISKY_KEYS = String.raw`^(core\.fsmonitor|diff\.external|diff\..*\.(textconv|command)|include\..*|includeif\..*)$`;

export type GitConfigRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

const runGit = (cwd: string): GitConfigRunner => (args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 128) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });

/**
 * True when the repository's config names a program git would run, or when that cannot be read.
 * Exit 1 is git's "no match", the only answer that clears it: a missing git, a timeout or a
 * folder that is not a repository all count as "could not look", and that asks.
 */
export async function gitConfigRunsPrograms(cwd: string, run: GitConfigRunner = runGit(cwd)): Promise<boolean> {
  const results = await Promise.all(['--local', '--worktree'].map((scope) => run(['config', scope, '--get-regexp', RISKY_KEYS])));
  return results.some((r) => r.code !== 1);
}
