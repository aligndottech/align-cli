import { execa } from 'execa';
import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * One spelling for one folder. git answers with a forward-slash long path on Windows while
 * process.cwd() can be a backslash 8.3 short one, and macOS has /var -> /private/var; realpath
 * (native) expands all of those and fixes the drive-letter case. A path that does not exist
 * cannot be resolved, so it falls back to a plain resolve.
 */
export function normalizeRepoPath(p: string): string {
  try {
    return path.resolve(realpathSync.native(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * The key a repo's run choice is stored under: the MAIN repository's root, so the repo, a
 * subdirectory of it and every `git worktree` of it share one answer. The git common dir is the
 * main repo's `.git`, and its parent is the root. Outside git it is the folder itself. Every
 * key goes through normalizeRepoPath, so one repo has one key whatever form its path arrives in.
 */
export async function runChoiceKey(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    const raw = stdout.trim();
    if (raw) {
      const common = normalizeRepoPath(raw);
      // A bare repo's common dir is the repo itself, not a `.git` inside a working tree: keep it as is.
      return path.basename(common) === '.git' ? path.dirname(common) : common;
    }
  } catch {
    // not a git repo, or git is missing
  }
  return normalizeRepoPath(cwd);
}
