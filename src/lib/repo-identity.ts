/**
 * ALI-798: the repo dimension for the local graph. Without this, every checkout's
 * decisions land in one global SQLite file with nothing recording which repo a row
 * came from - so `align ask` inside align-cli silently answers from align-stack's
 * commits too. This module is the one place identity is computed, so a decision's
 * import-time stamp and a `--repo <name>` filter can never drift apart.
 */
import { getRemoteUrl, getRepoRoot, isGitRepo } from './git.js';

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
 */
const HOSTED_REPO = /^https?:\/\/([^/\s]+)\/(.+?)(?:\/-)?\/(?:commit|pull|issues)\/[0-9a-zA-Z]+(?:[/?#]|$)/;

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
 * Returns null outside a git repo: there is nothing to stamp, and nothing to scope to
 * either (the ticket's own rule - "outside a git repo, default to all").
 */
export async function currentRepoIdentity(opts: { cwd?: string } = {}): Promise<string | null> {
  if (!(await isGitRepo(opts))) return null;
  const remote = await getRemoteUrl(opts);
  const fromRemote = repoFromRemoteUrl(remote);
  if (fromRemote) return fromRemote;
  return getRepoRoot(opts);
}

/**
 * Turns `--repo`/`--all` CLI flags into the `{ repo, all }` scope object
 * searchDecisions/listDecisions take - and, since the repo dimension is local-only
 * (ALI-798 scoped it to the local graph, not the cloud gateway), warns and drops them
 * when the resolved environment has no repo dimension at all. One place decides this so
 * every command that adds the flags applies the same rule (see ALI-505: a flag that
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
