import { execa } from 'execa';
import path from 'node:path';

/**
 * The key a repo's run choice is stored under: the MAIN repository's root, so the repo, a
 * subdirectory of it and every `git worktree` of it share one answer. The git common dir is the
 * main repo's `.git`, and its parent is the root. Outside git it is the folder itself.
 */
export async function runChoiceKey(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    const common = stdout.trim();
    // A bare repo's common dir is the repo itself, not a `.git` inside a working tree: keep it as is.
    if (common) return path.basename(common) === '.git' ? path.dirname(common) : common;
  } catch {
    // not a git repo, or git is missing
  }
  return cwd;
}
