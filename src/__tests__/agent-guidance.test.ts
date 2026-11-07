import { describe, expect, it } from 'vitest';
import { ASK_ONCE_GUIDANCE, CITE_RULE, LATER_ON_TOPIC_RULE } from '../lib/agent/agent-guidance.js';
import { MCP_INSTRUCTIONS_SHARED } from '../lib/mcp-instructions.shared.js';

// Each rule is its own claim, so each gets its own assertion, and each phrase is checked to
// appear exactly once: an assertion that matched a second copy elsewhere could not fail.
const once = (phrase: string) => {
  expect(ASK_ONCE_GUIDANCE.split(phrase).length - 1, phrase).toBe(1);
};

describe('the guidance both engines carry', () => {
  it('asks once and does not re-derive from code', () => {
    once('Ask the decision graph once per question');
    once('Do not repeat align_ask with new wording');
  });
  it('reads every relation field, not only the follow-up list', () => {
    for (const field of ['status', 'later_on_topic', 'successor', 'conflicts_with']) expect(ASK_ONCE_GUIDANCE).toMatch(new RegExp(`\\b${field}\\b`));
    once('Say plainly when two decisions disagree');
  });
  it('chases a missing follow-up instead of saying it did not see it', () => {
    once('read that decision with an available tool before answering');
  });
  it('leads with one sentence and caps each decision at one line', () => {
    once('Start with a one-sentence answer');
    once('at most one short line per decision');
  });
  it("links every decision cited, in the MCP server's own words, and never a bare code", () => {
    once(CITE_RULE);
    once('Link every decision you cite as a markdown link');
    once('Never cite a bare ticket code');
  });
  it("answers from a reversing decision, in the MCP server's own words", () => {
    once(LATER_ON_TOPIC_RULE);
  });
});

// The agent and every other MCP client must get the same advice. The MCP text is pinned to
// align-stack's copy byte for byte, so the agent's copy is pinned to it here.
describe('the guidance agrees with the MCP server instructions', () => {
  it("the citation rule is the MCP server's sentence, word for word", () => {
    expect(MCP_INSTRUCTIONS_SHARED).toContain(`- ${CITE_RULE}\n`);
  });
  it("the later-decision rule is the MCP server's phrase, word for word", () => {
    expect(MCP_INSTRUCTIONS_SHARED).toContain(`later_on_topic before answering; ${LATER_ON_TOPIC_RULE}.`);
  });
});
