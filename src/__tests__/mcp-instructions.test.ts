import { describe, expect, it } from 'vitest';
import { ALIGN_MCP_INSTRUCTIONS, TOOL_SCHEMAS } from '../commands/mcp';

describe('ALIGN_MCP_INSTRUCTIONS', () => {
  it('tells the agent to check alignment before changes and ask for context', () => {
    expect(ALIGN_MCP_INSTRUCTIONS).toMatch(/BEFORE writing or changing/i);
    expect(ALIGN_MCP_INSTRUCTIONS).toContain('align_check_alignment');
    expect(ALIGN_MCP_INSTRUCTIONS).toContain('align_ask');
    // a conflict should be treated as blocking
    expect(ALIGN_MCP_INSTRUCTIONS.toLowerCase()).toContain('conflict');
  });

  it('stays within the ~2KB server-instructions budget Claude Code truncates at', () => {
    expect(ALIGN_MCP_INSTRUCTIONS.length).toBeLessThan(2048);
  });

  // ALI-414: the agent-facing half of the "needs a human" state. An agent branches on
  // `status`, so it has to be told in words that `unknown` is not a pass - otherwise
  // it reads the absence of a conflict as permission to proceed.
  it('tells the agent that "unknown" means stop and ask the human', () => {
    expect(ALIGN_MCP_INSTRUCTIONS).toContain('unknown');
    expect(ALIGN_MCP_INSTRUCTIONS.toLowerCase()).toMatch(/not a pass|ask the (human|user)/);
  });

  // ALI-830: align_ask/align_search can return `decision_url` (cloud-only) and `source_url`
  // when available (gateway-client.ts), and the instructions never told the agent to use them - so
  // a decision named in prose (not a dated row from get_topic_timeline, which this server
  // does not have) shipped as bare text. Mirrors align-stack's mcpServer.test.ts equivalent.
  it('tells the agent to cite and link a decision', () => {
    expect(ALIGN_MCP_INSTRUCTIONS.toLowerCase()).toMatch(/\bcite\b/);
    expect(ALIGN_MCP_INSTRUCTIONS).toContain('decision_url');
  });

  // decision_url and source_url are both OPTIONAL on the payload (local-embedded decisions
  // carry no decision_url; some sources carry no citable source_url at all - decision-links.ts,
  // citation.test.ts). An unconditional "always cite/link" instruction asks the agent to
  // produce a field the payload may withhold, which invites fabrication (align-stack#1442).
  it('makes the cite/link instruction conditional on the field being present', () => {
    const citeLine = ALIGN_MCP_INSTRUCTIONS.split('\n').find(l => l.toLowerCase().includes('cite'));
    // Positive control: the line exists at all, so a missing line cannot pass the match below.
    expect(citeLine).toBeDefined();
    expect(citeLine!.toLowerCase()).toMatch(/\bwhen\b|\bif\b/);
  });
});

describe('align_check_alignment tool schema', () => {
  const checkTool = TOOL_SCHEMAS.find(t => t.name === 'align_check_alignment');

  it('exists (positive control for the assertions below)', () => {
    expect(checkTool).toBeDefined();
  });

  // The tool description travels with the tool call itself, so an agent that never
  // read the server instructions still gets the rule.
  it('documents "unknown" as stop-and-ask, not as a pass', () => {
    expect(checkTool!.description).toContain('unknown');
    expect(checkTool!.description.toLowerCase()).toMatch(/not a pass|ask the (human|user)/);
  });
});
