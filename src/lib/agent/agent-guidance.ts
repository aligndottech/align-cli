/**
 * One instruction both engines carry, for answering from the decision graph.
 *
 * Each line answers a failure seen in a real session:
 * - The model asked align_ask three times for one question, then went to grep and git log to
 *   re-derive what the first answer already said. A second call with new wording finds the same
 *   decisions and costs the person the wait.
 * - Asked whether webhooks fail open, it said it "didn't see" a follow-up's status that align_ask
 *   had returned twice (as a result and in later_on_topic), and it skipped a conflicts_with the
 *   graph flagged. The fields were there; nothing told it to read all of them.
 * - It cited decisions as bare ticket codes although every result carries a link, and opened
 *   with a paragraph where one sentence would do.
 *
 * The shape is given as rules with numbers, not adjectives, because "be brief" constrains nothing.
 */
/** Word for word from the MCP server's instructions (mcp-instructions.shared.ts, which must stay
 *  byte-identical to align-stack's copy). agent-guidance.test.ts fails if either side changes. */
export const CITE_RULE = 'Cite a decision by its cite value when present; link via decision_url if present, else source_url if present, else say no link - never present one as the other.';
export const LATER_ON_TOPIC_RULE = 'answer from one that reversed it';

export const ASK_ONCE_GUIDANCE = [
  'Ask the decision graph once per question. Do not repeat align_ask with new wording, and do not read the code or git history to re-derive what it said unless you are about to change behaviour.',
  `Before answering, read every returned decision's status, later_on_topic, successor and conflicts_with, including results that look minor: a later or conflicting decision can change the answer. Where a later decision reversed an earlier one, ${LATER_ON_TOPIC_RULE}. Say plainly when two decisions disagree.`,
  'If a later entry could change the answer and its details are missing, read that decision with an available tool before answering. If the details remain unavailable, say so.',
  'Start with a one-sentence answer. Then give at most one short line per decision you rely on.',
  `Link every decision you cite as a markdown link. ${CITE_RULE} Never cite a bare ticket code.`,
  'Then carry on with whatever else the person asked for, such as an edit.',
].join(' ');
