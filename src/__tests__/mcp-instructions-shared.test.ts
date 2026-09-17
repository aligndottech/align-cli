import { describe, expect, it } from 'vitest';
import { ALIGN_MCP_INSTRUCTIONS, TOOL_SCHEMAS } from '../commands/mcp.js';
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

  /**
   * ALI-1070 made this a WHOLE-WORD check, and that is the correction rather than a
   * loosening.
   *
   * This server now exposes the topic timeline as `align_get_topic_timeline`, and a
   * substring test cannot tell that token from the bare hosted spelling it contains - so
   * `not.toContain('get_topic_timeline')` fired on a correct instruction naming a tool that
   * IS registered here. Every name below stays on the list, because naming the bare hosted
   * spelling would still instruct a customer's agent to call a tool this server does not
   * have; only the matcher changed, so the assertion now means what it says.
   *
   * Same fix align-stack already applied to ALIGN_MCP_INSTRUCTIONS_READ_ONLY's filter
   * (Copilot, align-stack#1842): `includes('connect')` also matches "connected". A `\b`
   * costs nothing and removes the whole class. Note `_` is a word character, which is
   * exactly why `\bget_topic_timeline\b` does not match inside `align_get_topic_timeline`.
   */
  it('names no tool the local server does not expose', () => {
    for (const tool of ['check_proposed_action', 'rate_conflict', 'coach', 'get_topic_timeline', 'search_decisions']) {
      expect(ALIGN_MCP_INSTRUCTIONS, `local instructions name hosted-only tool ${tool}`).not.toMatch(
        new RegExp(`\\b${tool}\\b`),
      );
    }
  });

  /**
   * The other direction, and the one a hand-kept denylist cannot give you (ALI-1070).
   *
   * The list above is five names somebody thought of; this derives the invariant from what
   * the server actually registers, so a per-server line naming a MISSPELLED or a future
   * hosted-only tool fails here without anyone remembering to extend a list. That is the
   * "allowlist entry is a lie" shape closed with a computed check instead of vigilance.
   */
  it('names only align_ tools this server registers', () => {
    const registered = new Set(TOOL_SCHEMAS.map((t) => t.name));
    const named = ALIGN_MCP_INSTRUCTIONS.match(/align_[a-z_]+/g) ?? [];
    // Positive control: the instructions really do name tools, so an empty match set
    // cannot satisfy this vacuously.
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !registered.has(n))).toEqual([]);
  });

  it('leaves no unrendered token', () => {
    expect(ALIGN_MCP_INSTRUCTIONS).not.toMatch(/\{[a-z_]+\}/);
    expect(ALIGN_MCP_INSTRUCTIONS).toContain(MCP_INSTRUCTIONS_SHARED.slice(0, 40));
  });
});
