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

/** Removes the exact line ensureGitignored adds for `relPath`, and nothing else. Idempotent. */
export function removeGitignoreLine(repoRoot: string, relPath: string): 'removed' | 'absent' {
  const file = path.join(repoRoot, '.gitignore');
  let existing: string;
  try { existing = fs.readFileSync(file, 'utf8'); } catch { return 'absent'; }
  const lines = existing.split('\n');
  const kept = lines.filter((l) => l.trim() !== relPath);
  if (kept.length === lines.length) return 'absent';
  fs.writeFileSync(file, kept.join('\n'));
  return 'removed';
}

/**
 * Platforms whose decisions the repo already holds: its own commits, its committed docs and its pull requests. A
 * decisions file made only of these says nothing a clone does not, so it may be committed. Anything else (a chat, a
 * ticket, an agent session, a hand capture, a local tool's notes) is the person's own and keeps the file out of git.
 */
export const REPO_PLATFORMS: ReadonlySet<string> = new Set(['git', 'docs', 'github', 'gitlab']);

export function onlyFromTheRepo(platforms: readonly string[]): boolean {
  return platforms.length > 0 && platforms.every((p) => REPO_PLATFORMS.has(p));
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
