/**
 * The MCP server instructions Align's two servers SHARE.
 *
 * This file is committed in two repositories and is byte-identical in both:
 *   align-cli    src/lib/mcp-instructions.shared.ts            (the CLI's local server)
 *   align-stack  connectors/mcp-align/src/mcpInstructions.shared.ts  (the hosted server)
 * A parity test on each side reads the OTHER side's copy from its origin/main and fails on any
 * difference (ALI-952). Two texts for one contract had already drifted once: the local server
 * never told an agent to search the graph before reading the code. EDIT BOTH COPIES IN THE
 * SAME SITTING - a change to one repo fails that repo's parity test until the other merges.
 *
 * Tool names are TOKENS, because the two servers name the same tool differently
 * (`check_alignment` hosted, `align_check_alignment` local). Each server renders the tokens
 * through its own table; a token the table cannot name throws at render, so a line about a
 * tool only one server has cannot live here. Those lines go in the PER-SERVER section each
 * server appends via renderMcpInstructions.
 *
 * Budget: Claude Code truncates server instructions around 2,048 characters. Each server pins
 * its own RENDERED text (shared + per-server lines, plus the local server's graph-identity
 * suffix) under that limit. CUT BEFORE YOU ADD, and re-derive the length rather than trusting
 * a number written here.
 *
 * This is a .ts module rather than a .md file so the published CLI (which ships dist/ only)
 * has the text at runtime without a copy step, and so both repos lint and typecheck it.
 */

export const SHARED_MCP_TOOL_KEYS = ['check_alignment', 'search'] as const;
export type SharedMcpToolKey = (typeof SHARED_MCP_TOOL_KEYS)[number];

/**
 * Lines about the tools BOTH servers expose. No backtick anywhere in the prose: this is a
 * template literal, and a stray one ends it silently (align-stack mcpServer.test.ts).
 */
export const MCP_INSTRUCTIONS_SHARED = `Align is this team's decision graph - what was decided, why, and by whom. Use these tools proactively, without being asked:

- BEFORE writing or changing non-trivial code, call {check_alignment} with the diff, phrased as the DECISION and its value ("set the worker pool to 12"), never the chore ("wire up a worker"). A "conflict" result, or a matched decision whose OWN status is conflicted, means a past decision opposes the change - STOP and confirm with the user before proceeding.
- An "unknown" status means the check could not run (the service was unavailable) - it is NOT a pass. Surface it to the user and do not proceed as if aligned.
- To answer "why did we decide X" or to understand a convention, call {search}. A decision's status (active/conflicted) and who decided it are in the graph.
- Do the same for questions ABOUT BEHAVIOUR, which rarely name a decision: "what happens when X fails", "does it fail open", "how does Y work".
- Cite by cite value when present; link via decision_url if present, else source_url if present, else say no link - never present one as the other.
- When the question was only a question, REPORT what the graph returned, with its titles and source links, and do not re-derive it from the code. Read the code to confirm only when you are about to change behaviour.
- Search the graph BEFORE reading the code: it spans repositories, so grepping this checkout misses decisions made in another repository.`;

/**
 * Render the shared text for one server: substitute each {token} with that server's name for
 * the tool, then append the server's own lines (tools only it exposes), one per line.
 * Throws on a token the table does not name rather than emitting a literal brace for the
 * agent to puzzle over.
 */
export function renderMcpInstructions(
  toolNames: Record<SharedMcpToolKey, string>,
  perServerLines: readonly string[],
): string {
  const names = toolNames as Record<string, string | undefined>;
  const rendered = MCP_INSTRUCTIONS_SHARED.replace(/\{([a-z_]+)\}/g, (_match, key: string) => {
    const name = names[key];
    if (!name) throw new Error(`MCP instructions name a tool this server has no name for: {${key}}`);
    return name;
  });
  return perServerLines.length ? `${rendered}\n${perServerLines.join('\n')}` : rendered;
}
