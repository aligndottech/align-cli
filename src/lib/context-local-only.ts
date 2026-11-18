import { execFileSync } from 'node:child_process';
import { humanizeFilename } from './fetchers/docs.js';
import { currentRepoIdentitySync } from './repo-identity.js';
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
  // `/x` and `x` name the same root-level file; broader rules (`.align/`) cover other files too and are left alone.
  const kept = lines.filter((l) => l.trim().replace(/^\//, '') !== relPath);
  if (kept.length === lines.length) return 'absent';
  // Written beside it and renamed over it, so no reader sees a half-written .gitignore and an interruption loses nothing.
  const tmp = `${file}.align-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, kept.join('\n'));
    fs.renameSync(tmp, file);
  } catch (err) {
    // A stray temp file in the repo root is one `git add .` from being committed.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return 'removed';
}

/**
 * Platforms whose decisions the repo already holds: its own commits, its committed docs and its pull requests. A
 * decisions file made only of these says nothing a clone does not, so it may be committed. Anything else (a chat, a
 * ticket, an agent session, a hand capture, a local tool's notes) is the person's own and keeps the file out of git.
 */
export const REPO_PLATFORMS: ReadonlySet<string> = new Set(['git', 'docs', 'github', 'gitlab']);

/**
 * True only when every row is something this repo already holds, so the file adds nothing a clone does not:
 *  - a repo platform (git, docs, github, gitlab);
 *  - its source is THIS repo (the remote's github.com/<owner>/<repo>, or a remote-less repo's own git:// URL), so a
 *    pull request read from a private sibling repo never lands in a committed file;
 *  - a docs row's file is tracked by git, so a gitignored or never-committed CLAUDE.md or notes file stays private.
 * Anything it cannot establish counts as private.
 */
export function committableFromRepo(rows: ReadonlyArray<{ platform: string; title?: string | null; source_url?: string | null }>, repoRoot: string): boolean {
  if (rows.length === 0) return false;
  const repo = currentRepoIdentitySync({ cwd: repoRoot });
  return rows.every((r) => {
    if (!REPO_PLATFORMS.has(r.platform) || !r.source_url) return false;
    const url = r.source_url;
    let refAndPath: string | undefined;
    if (url.startsWith('git://')) {
      // A repo with no hosted remote: a git:// URL names no repository, so it is only accepted when this repo can
      // prove it is its own. A commit can (the sha is in this repo's history); a document cannot, so it stays private.
      if (repo !== null && /^(github|gitlab)\.com\//.test(repo)) return false;
      const sha = /^git:\/\/commit\/([0-9a-f]{7,40})$/i.exec(url)?.[1];
      return r.platform === 'git' && sha !== undefined && commitInRepo(repoRoot, sha);
    } else {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return false; }
      const hostPath = `${parsed.host}${parsed.pathname}`.toLowerCase();
      if (!repo || !hostPath.startsWith(`${repo}/`)) return false;
      refAndPath = /\/(?:-\/)?blob\/(.+)$/.exec(parsed.pathname)?.[1];
    }
    if (r.platform !== 'docs') return true;
    if (refAndPath === undefined) return false;
    let decoded: string;
    try { decoded = decodeURIComponent(refAndPath); } catch { return false; }
    const relPath = stripRef(decoded, currentBranch(repoRoot));
    // Tracked AND unchanged: the docs reader reads the working tree, so an uncommitted edit is private text.
    // The path a URL names can be reinterpreted (a renamed branch, a %-escape, a file committed after the import), so the
    // path alone proves nothing. What has to be true is that the text this row renders is already in the committed file.
    return relPath !== undefined && isTrackedByGit(repoRoot, relPath) && unchangedFromHead(repoRoot, relPath)
      && titleIsInCommittedFile(repoRoot, relPath, r.title);
  });
}

/** The .gitignore rule that still ignores `relPath` (e.g. `.align/`), or null when git says it is not ignored. Never throws. */
export function ignoringRule(repoRoot: string, relPath: string): string | null {
  // check-ignore takes plain paths (it rejects pathspec magic such as --literal-pathspecs) and exits 1 for "not ignored".
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'check-ignore', '-v', '--', relPath], { stdio: 'pipe' }).toString().trim();
    // `<source>:<line>:<pattern>\t<path>`
    return /^[^:]*:\d+:([^\t]*)\t/.exec(out)?.[1] ?? out;
  } catch (err) {
    // Exit 1 is the only "not ignored". Anything else could not look, and must not read as "safe to commit".
    return (err as { status?: number }).status === 1 ? null : 'unknown (git check-ignore failed)';
  }
}

/**
 * The document path inside `<ref>/<path>`. A branch name can contain slashes, so the current branch is stripped
 * when it prefixes the string; otherwise the ref is taken as one segment. A wrong split only ever names a path
 * that is not tracked, which keeps the file private.
 */
export function stripRef(refAndPath: string, branch: string | null): string | undefined {
  if (branch && refAndPath.startsWith(`${branch}/`)) return refAndPath.slice(branch.length + 1) || undefined;
  const i = refAndPath.indexOf('/');
  return i > 0 ? refAndPath.slice(i + 1) || undefined : undefined;
}

function currentBranch(repoRoot: string): string | null {
  try {
    const b = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' }).toString().trim();
    return b && b !== 'HEAD' ? b : null;
  } catch { return null; }
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

/** The row's title is in HEAD's copy of the file, or is the name the docs reader derives from that file's name. */
function titleIsInCommittedFile(repoRoot: string, relPath: string, title: string | null | undefined): boolean {
  if (!title?.trim()) return false;
  if (title === humanizeFilename(relPath)) return true;
  try {
    const committed = execFileSync('git', ['-C', repoRoot, 'show', `HEAD:${relPath}`], { stdio: 'pipe' }).toString();
    return squash(committed).includes(squash(title));
  } catch { return false; }
}

function unchangedFromHead(repoRoot: string, relPath: string): boolean {
  try {
    execFileSync('git', ['--literal-pathspecs', '-C', repoRoot, 'diff', '--quiet', 'HEAD', '--', relPath], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function commitInRepo(repoRoot: string, sha: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

/** Is `relPath` already tracked by git? False outside a repo, and never throws. */
export function isTrackedByGit(repoRoot: string, relPath: string): boolean {
  try {
    // --literal-pathspecs: a filename like `[ab].md` must not match a tracked `a.md`.
    execFileSync('git', ['--literal-pathspecs', '-C', repoRoot, 'ls-files', '--error-unmatch', '--', relPath], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
