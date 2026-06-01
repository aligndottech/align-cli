import { describe, expect, it } from 'vitest';
import { ALIGN_MCP_INSTRUCTIONS } from '../commands/mcp';

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
});
