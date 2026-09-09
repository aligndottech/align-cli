import { describe, expect, it } from 'vitest';
import { ALIGN_MCP_INSTRUCTIONS } from '../commands/mcp.js';
import {
  MCP_INSTRUCTIONS_SHARED,
  renderMcpInstructions,
  SHARED_MCP_TOOL_KEYS,
} from '../lib/mcp-instructions.shared.js';

/**
 * ALI-952: the local server's instructions and the hosted server's (align-stack
 * connectors/mcp-align/src/mcpServer.ts) were two texts for one contract, and they had
 * drifted - the local one never told an agent to search the graph BEFORE reading the code,
 * and never said a matched decision whose own status is conflicted is a stop. One shared
 * text now, rendered per server through a tool-name table; mcp-instructions-parity.test.ts
 * pins that the shared file is byte-identical across the two repositories.
 */
const LOCAL_NAMES = { check_alignment: 'align_check_alignment', search: 'align_ask' } as const;

describe('renderMcpInstructions', () => {
  it('substitutes every {token} with this server\'s tool name', () => {
    const text = renderMcpInstructions(LOCAL_NAMES, []);
    expect(text).toContain('align_check_alignment');
    expect(text).toContain('align_ask');
    expect(text).not.toMatch(/\{[a-z_]+\}/);
  });

  // The two servers name the same tool differently, so a token is the only way one text can
  // serve both. A token the table cannot name is a line about a tool THIS server lacks -
  // exactly what the per-server section exists for - so it must fail loudly, not render as
  // a literal brace for the agent to puzzle over.
  it('throws on a token the tool table does not name', () => {
    const partial = { check_alignment: 'align_check_alignment' } as unknown as typeof LOCAL_NAMES;
    expect(() => renderMcpInstructions(partial, [])).toThrow(/\{search\}/);
  });

  it('appends the per-server lines after the shared block, one per line', () => {
    const text = renderMcpInstructions(LOCAL_NAMES, ['- only here', '- and here']);
    expect(text.endsWith('- only here\n- and here')).toBe(true);
    // Positive control for the "names no hosted-only tool" assertion below: the mechanism
    // that WOULD put check_proposed_action into a rendered text works.
    expect(renderMcpInstructions(LOCAL_NAMES, ['- call check_proposed_action'])).toContain('check_proposed_action');
  });

  it('every token in the shared text is one of the declared keys', () => {
    const tokens = [...MCP_INSTRUCTIONS_SHARED.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    // Positive control: the shared text carries tokens at all.
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(SHARED_MCP_TOOL_KEYS as readonly string[]).toContain(t);
  });
});

describe('ALIGN_MCP_INSTRUCTIONS is the shared text rendered for the local server', () => {
  it('carries the directives the local text used to lack', () => {
    expect(ALIGN_MCP_INSTRUCTIONS.toLowerCase()).toMatch(/search the graph before reading the code/);
    expect(ALIGN_MCP_INSTRUCTIONS.toLowerCase()).toMatch(/own status|itself conflicted/);
    expect(ALIGN_MCP_INSTRUCTIONS.toLowerCase()).toMatch(/never the chore|not the chore/);
  });

  it('names no tool the local server does not expose', () => {
    for (const tool of ['check_proposed_action', 'rate_conflict', 'coach', 'get_topic_timeline', 'search_decisions']) {
      expect(ALIGN_MCP_INSTRUCTIONS, `local instructions name hosted-only tool ${tool}`).not.toContain(tool);
    }
  });

  it('leaves no unrendered token', () => {
    expect(ALIGN_MCP_INSTRUCTIONS).not.toMatch(/\{[a-z_]+\}/);
    expect(ALIGN_MCP_INSTRUCTIONS).toContain(MCP_INSTRUCTIONS_SHARED.slice(0, 40));
  });
});
