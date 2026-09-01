/**
 * The CLI-local citation reader: everything the shared `citationFor` cites, plus
 * commit URLs (ALI-792).
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

/** "cli@abc1234" for a hosted commit, "abc1234" for a remoteless one, else whatever
 *  the shared reader says (repo#N, ticket key, or undefined). */
export function localCitationFor(sourceUrl: string | null | undefined): string | undefined {
  const shared = citationFor(sourceUrl);
  if (shared) return shared;
  if (!sourceUrl) return undefined;
  const hosted = HOSTED_COMMIT.exec(sourceUrl);
  if (hosted) return `${hosted[1]}@${hosted[2].slice(0, 7)}`;
  const local = LOCAL_COMMIT.exec(sourceUrl);
  return local ? local[1].slice(0, 7) : undefined;
}
