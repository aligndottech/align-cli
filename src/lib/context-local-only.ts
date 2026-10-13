import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keeps the decisions file written by `align context sync` on this machine when the graph behind it is local.
 *
 * A local graph is private: it is built with personal read-only tokens, and nothing in it leaves the machine
 * until `align share`, which previews each decision, scans for secrets and needs a person's yes. The decisions
 * file carries titles and source links, so a committed copy would reach every colleague and every agent in the
 * repo without any of that. Ignoring it in git keeps the file useful to the agent on this machine, and leaves
 * sharing to the one path that was built for it.
 */

/** The `.gitignore` lines that already cover `relPath` (an exact path, its directory, or the directory's contents). */
function covers(line: string, relPath: string): boolean {
  const t = line.trim().replace(/^\//, '');
  if (t === '' || t.startsWith('#') || t.startsWith('!')) return false;
  const dir = path.posix.dirname(relPath);
  return t === relPath || t === dir || t === `${dir}/` || t === `${dir}/*`;
}

/** Adds `relPath` to the repo's `.gitignore` unless it is already ignored. Idempotent. */
export function ensureGitignored(repoRoot: string, relPath: string): 'added' | 'already' {
  const file = path.join(repoRoot, '.gitignore');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // No .gitignore yet: the first line creates it.
  }
  if (existing.split('\n').some((l) => covers(l, relPath))) return 'already';
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${existing}${sep}${relPath}\n`);
  return 'added';
}

/** Is `relPath` already tracked by git? False outside a repo, and never throws. */
export function isTrackedByGit(repoRoot: string, relPath: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', relPath], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
