/**
 * The repo dimension for the local graph. Without this, every checkout's
 * decisions land in one global SQLite file with nothing recording which repo a row
 * came from - so `align ask` inside align-cli silently answers from align-stack's
 * commits too. This module is the one place identity is computed, so a decision's
 * import-time stamp and a `--repo <name>` filter can never drift apart.
 */
import { execFileSync } from 'node:child_process';
import { CORE_BARE_ARGS, getRemoteUrl, getRepoRoot, GIT_DIRS_ARGS, gitOutput, isGitRepo } from './git.js';

/**
 * `host/owner/repo`, lowercased, parsed out of a hosted commit/pull/issue URL - or null
 * for anything that does not identify a repo (a ticket URL, a remoteless
 * `git://commit/<sha>`, a bare host).
 *
 * Lowercased deliberately: GitHub and GitLab paths are case-insensitive, and collapsing
 * two differently-cased links to the same repo into one identity is worth more than
 * preserving a URL's original casing - the ticket's own example ("two clones of the same
 * remote group as one repo, not two") is exactly this kind of accidental divergence.
 *
 * Requires a `/` in what follows the host: a bare `owner` before `/pull/N` or
 * `/commit/<sha>` is a user or org page, not a repo, and admitting it would invent a
 * "repo" named after an org. A `-` marker (GitLab's `/-/commit/`) is optional so both
 * `gitlab.com/g/repo/-/commit/x` and a plain `commit`/`pull`/`issues` path match, and a
 * GitLab subgroup path (`group/sub/repo`) survives intact rather than being cut at the
 * first slash.
 *
 * `merge_requests` (Copilot review, #225): GitLab's own name for a pull request, and the
 * verb `GitLabFetcher.fetch` (connector-core) actually stamps on `source_url` via `web_url`
 * - without it, every GitLab import landed unattributed, silently defeating repo scoping
 * for GitLab users specifically. Verified against the fetcher's real output, not just the
 * URL shape.
 */
const HOSTED_REPO = /^https?:\/\/([^/\s]+)\/(.+?)(?:\/-)?\/(?:commit|pull|issues|merge_requests)\/[0-9a-zA-Z]+(?:[/?#]|$)/;

export function repoFromSourceUrl(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const m = HOSTED_REPO.exec(sourceUrl);
  if (!m) return null;
  const ownerPath = m[2];
  if (!ownerPath.includes('/')) return null;
  return `${m[1]}/${ownerPath}`.toLowerCase();
}

/**
 * The same identity, derived from a git REMOTE url instead of a commit URL - for a git
 * item whose source_url has no commit/pull path to match against (there is none; the
 * remote IS the identity).
 *
 * Mirrors `buildCommitUrl`'s host detection (lib/git.ts) branch-for-branch on purpose:
 * these are two writers of one fact (which repo a remote names), and letting them diverge
 * would mean `repoFromSourceUrl(buildCommitUrl(remote, sha))` and `repoFromRemoteUrl(remote)`
 * silently disagreeing about the same remote - a git-sourced decision stamped under one
 * identity by the importer and looked up under another by a `--repo` filter. The parity
 * test in repo-identity.test.ts is what keeps that from drifting unnoticed.
 */
export function repoFromRemoteUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const sshGh = remoteUrl.match(/git@github\.com[:/](.+?)(?:\.git)?$/);
  if (sshGh) return `github.com/${sshGh[1]}`.toLowerCase();
  const httpsGh = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (httpsGh) return `github.com/${httpsGh[1]}`.toLowerCase();
  const gl = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
  if (gl) return `gitlab.com/${gl[1]}`.toLowerCase();
  return null;
}

/**
 * The identity of the repo the CLI is currently running in, for stamping a git-sourced
 * decision whose remote is unrecognised or absent (a self-hosted GHES, a local-only repo
 * never pushed anywhere). Falls back to the absolute repo root path - a path always starts
 * with `/` (or a drive letter), which can never collide with the `host/owner/repo` shape
 * above, so the two identity spaces never need disambiguating.
 *
 * In a linked worktree the path is the MAIN checkout's root, not the worktree's own: a
 * worktree is one more folder of the same repo, and naming it after its own folder made
 * every scoped read there miss the decisions stamped from the main checkout.
 *
 * Returns null outside a git repo: there is nothing to stamp, and nothing to scope to
 * either (the ticket's own rule - "outside a git repo, default to all").
 */
export async function currentRepoIdentity(opts: { cwd?: string } = {}): Promise<string | null> {
  if (!(await isGitRepo(opts))) return null;
  const remote = await getRemoteUrl(opts);
  const fromRemote = repoFromRemoteUrl(remote);
  if (fromRemote) return fromRemote;
  return mainRootOfLinkedWorktree(await gitOutput(GIT_DIRS_ARGS, opts), await gitOutput(CORE_BARE_ARGS, opts)) ?? getRepoRoot(opts);
}

const SHARED_DOT_GIT = '/.git';

/**
 * The main checkout's root when the folder asked about is a linked worktree of it, read from two
 * git answers: `rev-parse --path-format=absolute --git-dir --git-common-dir` (two lines) and
 * `config --bool core.bare`. Null everywhere else, so the caller keeps the repo root it always
 * used: in a main checkout (the two folders are one), when git gave no answer, and when there is
 * no main checkout to name - a bare repo (whatever its folder is called, `.git` included) or a
 * shared folder that is not a checkout's `.git` (a submodule).
 *
 * The root is the shared folder minus its `/.git`, in git's own spelling (forward slashes on
 * Windows too), which is what `--show-toplevel` prints for the main checkout - so a decision
 * stamped there and a read from a worktree agree byte for byte.
 */
export function mainRootOfLinkedWorktree(gitDirs: string | null, coreBare: string | null): string | null {
  if (coreBare?.trim() === 'true') return null;
  const [own, shared] = (gitDirs ?? '').split(/\r?\n/).map((l) => l.trim());
  if (!own || !shared || own === shared || !shared.endsWith(SHARED_DOT_GIT)) return null;
  return shared.slice(0, -SHARED_DOT_GIT.length) || null;
}

/** Set on a background sync child: the repo it was started for. The child runs from the home directory, so the folder cannot say. */
export const SYNC_REPO_ENV = 'ALIGN_SYNC_REPO';

/**
 * `currentRepoIdentity`, read synchronously, for the callers that cannot await (the scope store is a sync seam). Same answer by the same
 * steps: not a git repo is null, a recognised remote is `host/owner/repo`, anything else is the absolute repo root (the main checkout's, in a linked worktree).
 * scope-per-repo.test.ts holds the two to each other.
 */
/** A git call that hangs (a stalled network mount, a lock) must not hang the scope store with it. */
const GIT_TIMEOUT_MS = 5000;

/** The repo identity of a folder (its remote, else its top-level path), read synchronously with a timeout on each git call. Null outside a git repo. */
export function currentRepoIdentitySync(opts: { cwd?: string } = {}): string | null {
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync('git', args, { ...(opts.cwd ? { cwd: opts.cwd } : {}), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  };
  if (git('rev-parse', '--git-dir') === null) return null;
  return repoFromRemoteUrl(git('remote', 'get-url', 'origin')) ?? mainRootOfLinkedWorktree(git(...GIT_DIRS_ARGS), git(...CORE_BARE_ARGS)) ?? git('rev-parse', '--show-toplevel');
}

/**
 * Turns `--repo`/`--all` CLI flags into the `{ repo, all }` scope object
 * searchDecisions/listDecisions take - and, since the repo dimension is local-only
 * (it is scoped to the local graph, not the cloud gateway), warns and drops them
 * when the resolved environment has no repo dimension at all. One place decides this so
 * every command that adds the flags applies the same rule (a flag that
 * silently does nothing is a bug, not a graceful degradation).
 *
 * Returns undefined for "no scope opinion" - a caller passes that straight through to
 * searchDecisions/listDecisions, which apply their own default (current repo, or all
 * outside one) exactly as if neither flag had been typed.
 */
export function resolveScopeOpts(
  opts: { repo?: string; all?: boolean },
  envName: string,
  warn: (message: string) => void,
): { repo?: string; all?: boolean } | undefined {
  if (opts.repo === undefined && !opts.all) return undefined;
  if (envName !== 'local') {
    warn('--repo/--all only apply in local mode (no account, or `--local`) - showing everything.');
    return undefined;
  }
  return { repo: opts.repo, all: opts.all };
}
