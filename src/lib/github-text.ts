/**
 * Where a GitHub item's discussion starts inside its stored text.
 *
 * connector-core builds `raw_text` as a header (title, body, then `Status: <state>` and, for a PR,
 * `Repo: <owner/repo>`) followed by the discussion sections, each opening `\n\n## <heading>` with
 * heading one of Comments, Code Reviews or Review Comments. The header changes when a PR is merged
 * or renamed or its body is edited; the discussion does not. So "is this arrival thinner" cannot be
 * a text prefix. It is structural: the discussion block is what follows the Status line and begins
 * with one of those headings. A `## Comments` inside the PR body is not preceded by a Status line,
 * so it is not mistaken for the block.
 */
const BLOCK_START = /\n\nStatus: [^\n]*(?:\nRepo: [^\n]*)?(?=\n\n## (?:Comments|Code Reviews|Review Comments)\n)/;

/** Index where the discussion block begins (at its leading blank line), or -1 when there is none. */
export function discussionStart(text: string): number {
  const m = BLOCK_START.exec(text);
  return m ? m.index + m[0].length : -1;
}
