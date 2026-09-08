/**
 * Readers for the source URL a decision came from: which repository, and how a human
 * would cite it.
 *
 * These are byte-identical to `connectors/mcp-align/src/tools/format.ts` in align-stack,
 * deliberately. The two servers answer the same questions about the same decisions, and
 * the CLI's align_ask returned bare rows with no repository and no citation while the
 * hosted connector returned both - so the same question gave a visibly worse answer
 * depending on which server the agent happened to be connected to.
 *
 * They belong in `@aligndottech/connector-core` (both packages already depend on it) and
 * should move there at its next release: they are pure plumbing - parsing a URL shape,
 * no decision intelligence - which is exactly what the OSS SDK is for. Duplicating
 * fifteen lines of regex across two repos is the smaller cost today than blocking on a
 * three-repo publish chain, but it is a duplicate and it should not stay one.
 *
 * ALI-923: `isSyntheticSource`/`navigableSourceUrl` below are the one part of the copy
 * that this file used to omit entirely. Every local CLI row has `sourceUrl: null` today,
 * so the gap was harmless - but `align context sync` and `align why` both read decisions
 * from the HOSTED gateway (createGatewayClient, not the local db), and a hosted decision
 * can carry a synthetic `align://claimed/...` / `align://unsourced/...` identity (ALI-538:
 * minted by `claimedIdentityFor` in align-stack's
 * services/gateway/src/discover/suggestionHelpers.ts, for a scan that could not verify
 * where a decision was made). Without this guard, that identity was printed straight into
 * `.align/decisions.md` and `align why`'s output as if it were a clickable link - it is a
 * syntactically valid URI, so nothing throws, it just points nowhere. Ported from
 * align-stack's per-connector `syntheticSource.ts` (mcp-jira/mcp-github/mcp-teams,
 * ALI-567); wired into the CLI's own render sites in `commands/context.ts` and
 * `commands/why.ts`, which call `navigableSourceUrl` before printing a source as a link.
 *
 * NOT yet wired into `commands/mcp.ts`'s tool-call dispatch: that path forwards the
 * gateway's raw JSON response straight into the connected agent's context
 * (`serializeMcpResult`), which is architecturally the same problem align-stack's
 * `withSourceProvenance`/`sourceFields` solve at the connector layer - but doing that here
 * means rewriting every tool's result shape, not adding two functions to this file, so it
 * is a separate, larger change.
 */

/**
 * One reader of the source-URL format, used by both extractors below.
 *
 * Deliberately NOT anchored to github.com. A self-hosted tenant runs GitHub Enterprise Server
 * on its own hostname, so a host-anchored pattern returns nothing for every decision that
 * tenant owns - the packaged product would silently lose the repository attribution that is
 * the whole point of the field. Matching the path shape instead works for github.com, GHES,
 * and any host that serves the same /owner/repo/pull/N routes.
 *
 * The pull-or-issue segment is what keeps it honest: "two path segments on some host" would
 * also match a Jira browse URL, a Linear issue and a Confluence page, inventing repositories
 * that do not exist. Requiring the numbered PR/issue path costs commit-sourced URLs their
 * attribution and buys no false positives, which is the right side of that trade.
 */
const CODE_REF = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/;

/** The "owner/repo" a decision came from, or undefined when it did not come from code. */
export function repositoryOf(sourceUrl: string | null | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  const m = CODE_REF.exec(sourceUrl);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Tracker tickets have their own native cite - the key humans already say out
 * loud ("ALI-346", "PROJ-123") - so those URLs cite by key rather than getting
 * a repo#number invented for them. Deliberately NOT folded into CODE_REF:
 * repositoryOf must keep returning undefined for these, because a Linear
 * workspace is not an owner and a ticket key is not a repository (that refusal
 * is CODE_REF's documented point). The KEY-123 shape is required in full, so a
 * bare word in the issue slot cites nothing.
 */
const LINEAR_ISSUE = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:[/?#]|$)/;
const JIRA_ISSUE = /^https?:\/\/[^/\s]+\/browse\/([A-Z][A-Z0-9]*-\d+)(?:[/?#]|$)/;

/**
 * A decision rendered the way a human cites one: "align-cli#76" for code,
 * the ticket key ("ALI-346") for tracker decisions.
 *
 * `repository` already carries the same fact, and the agent still wrote prose naming titles
 * and dates but not repositories - so which repo a decision came from was only discoverable
 * by opening its link. Composing owner/repo plus a PR number is work the model must choose to
 * do; a ready-made string is work it only has to copy.
 *
 * Short repo name rather than owner/repo, because this is for prose. `repository` sits beside
 * it with the full path when a tenant has same-named repos under two owners.
 */
export function citationFor(sourceUrl: string | null | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  const m = CODE_REF.exec(sourceUrl);
  if (m) return `${m[2]}#${m[3]}`;
  const ticket = LINEAR_ISSUE.exec(sourceUrl) ?? JIRA_ISSUE.exec(sourceUrl);
  return ticket ? ticket[1] : undefined;
}

/**
 * Identities Align mints when a scan could not verify where a decision was made
 * (ALI-538): `align://claimed/<hash>` when the model claimed a source,
 * `align://unsourced/<hash>` when it claimed nothing. Minted in align-stack's
 * services/gateway/src/discover/suggestionHelpers.ts - this is a second writer of that
 * list, same position as align-stack's own per-connector copies (mcp-align, mcp-teams,
 * mcp-github, mcp-jira, the UI). No package here is a dependency of the gateway, so the
 * list is spelled again; keep it in sync if the gateway ever mints a third namespace.
 */
export const SYNTHETIC_SOURCE_PREFIXES: readonly string[] = [
  'align://claimed/',
  'align://unsourced/',
];

/** True when this source_url is an identity Align minted, not a place anyone can open. */
export function isSyntheticSource(sourceUrl: string | undefined | null): boolean {
  if (typeof sourceUrl !== 'string') return false;
  // startsWith, never includes: a real page may carry the text in its path.
  return SYNTHETIC_SOURCE_PREFIXES.some((prefix) => sourceUrl.startsWith(prefix));
}

/**
 * The source url, only when it is somewhere a person can go. `undefined` otherwise, so
 * every caller renders nothing rather than a dead `align://` link - never fall back to
 * inventing a substitute link here; that is the caller's call (e.g. a decision-page URL).
 */
export function navigableSourceUrl(sourceUrl: string | undefined | null): string | undefined {
  if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) return undefined;
  return isSyntheticSource(sourceUrl) ? undefined : sourceUrl;
}
