/**
 * The CLI-local citation reader: everything the shared `citationFor` cites, plus
 * commit URLs (ALI-792) and GitLab merge requests/issues (ALI-796).
 *
 * A wrapper rather than an edit to decision-links.ts, deliberately: that file is
 * byte-identical to mcp-align's copy in align-stack and documents that parity as
 * load-bearing. Its CODE_REF refuses commit URLs on purpose (a /commit/ path proves
 * nothing about pull/issue routes), which left every git-imported decision rendering
 * as a bare UUID in local output. The commit cite lives here, on the CLI's rendering
 * paths only, until both readers move into connector-core together.
 */
import { citationFor } from './decision-links.js';

// The repo is the LAST path segment before /commit (with GitLab's /-/ marker allowed in
// between), so subgroup paths (gitlab.com/group/subgroup/repo/-/commit/sha) cite by the
// repo rather than failing to undefined - buildCommitUrl emits exactly that shape for
// subgroup remotes (review finding, 2026-09-01).
const HOSTED_COMMIT = /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)*?([^/\s]+?)(?:\/-)?\/commit\/([0-9a-f]{7,40})(?:[/?#]|$)/;
const LOCAL_COMMIT = /^git:\/\/commit\/([0-9a-f]{7,40})(?:[/?#]|$)/;
/**
 * GitLab merge requests and issues route through `/merge_requests/N` and `/issues/N`,
 * with an optional `/-/` marker (required on gitlab.com since ~2019, still optional on
 * older self-managed instances) - a shape the shared CODE_REF cannot see at all, since
 * it only recognises "pull" and "issues" with no separator in between (ALI-796 review
 * finding: refIdentityFor('gitlab', ...) silently returned [] for every real GitLab
 * source, so a pre-existing gap could be marked "connected" and never actually
 * resolved into a link). Subgroup-aware the same way HOSTED_COMMIT is, for the same
 * reason: the repo is the last segment before the marker, not the first after the host.
 */
const GITLAB_MR_OR_ISSUE = /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)*?([^/\s]+?)(?:\/-)?\/(?:merge_requests|issues)\/(\d+)(?:[/?#]|$)/;

/** "cli@abc1234" for a hosted commit, "cli#78" for a GitLab MR/issue, "abc1234" for a
 *  remoteless commit, else whatever the shared reader says (repo#N, ticket key, or
 *  undefined). */
export function localCitationFor(sourceUrl: string | null | undefined): string | undefined {
  const shared = citationFor(sourceUrl);
  if (shared) return shared;
  if (!sourceUrl) return undefined;
  const hosted = HOSTED_COMMIT.exec(sourceUrl);
  if (hosted) return `${hosted[1]}@${hosted[2].slice(0, 7)}`;
  const gitlab = GITLAB_MR_OR_ISSUE.exec(sourceUrl);
  if (gitlab) return `${gitlab[1]}#${gitlab[2]}`;
  const local = LOCAL_COMMIT.exec(sourceUrl);
  return local ? local[1].slice(0, 7) : undefined;
}
