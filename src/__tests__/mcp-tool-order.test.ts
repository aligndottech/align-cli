import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import { dispatchTool, TOOL_SCHEMAS, toolSchemasFor } from '../commands/mcp.js';

/**
 * ALI-952 / ALI-139: the pre-flight check LEADS the MCP surface. ALI-139 (2026-06-03) decided
 * "prescription over retrieval" and the hosted server registers check_alignment first; the
 * local server listed align_search, align_ask, align_capture and then the check fourth. An
 * agent picking from the tool list alone reads that order as a ranking.
 *
 * And align_search / align_ask were two entries for one gateway call (searchDecisions) with
 * two dispatch arms that could drift - align_search passed no limit, align_ask defaulted to 8.
 * One dispatch path now; align_search stays callable as the alias.
 */

const localEnv = { mode: 'local-embedded', gatewayUrl: '' } as unknown as EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't' } as unknown as EnvironmentConfig;

describe('the local MCP tool list leads with the check (ALI-139)', () => {
  it('lists align_check_alignment first in TOOL_SCHEMAS', () => {
    expect(TOOL_SCHEMAS[0]?.name).toBe('align_check_alignment');
  });

  // toolSchemasFor is what tools/list actually returns; the order must survive its rewrite.
  it.each([
    ['local-embedded', localEnv],
    ['cloud', cloudEnv],
  ])('lists align_check_alignment first in what tools/list returns (%s)', (_label, env) => {
    expect(toolSchemasFor(env)[0]?.name).toBe('align_check_alignment');
  });

  it('keeps every tool exactly once (the reorder dropped or duplicated nothing)', () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'align_check_alignment', 'align_ask', 'align_search', 'align_capture', 'align_check_drift',
      'align_get_impact', 'align_get_conflicts', 'align_get_related_decisions',
    ]));
    expect(names).toHaveLength(8);
  });
});

describe('align_search is an alias of align_ask: one dispatch path', () => {
  type Client = Parameters<typeof dispatchTool>[2];
  const client = () => {
    const c = { searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }) };
    return { c, cast: c as unknown as Client };
  };

  it('the same text reaches searchDecisions with the same arguments through either name', async () => {
    const ask = client();
    await dispatchTool('align_ask', { question: 'why postgres' }, ask.cast, cloudEnv);
    const search = client();
    await dispatchTool('align_search', { query: 'why postgres' }, search.cast, cloudEnv);
    expect(ask.c.searchDecisions.mock.calls).toEqual(search.c.searchDecisions.mock.calls);
    // Positive control: the call happened at all, so two empty call lists cannot pass.
    expect(ask.c.searchDecisions).toHaveBeenCalledTimes(1);
  });

  it('an explicit limit is honoured through either name', async () => {
    const ask = client();
    await dispatchTool('align_ask', { question: 'q', limit: 3 }, ask.cast, cloudEnv);
    const search = client();
    await dispatchTool('align_search', { query: 'q', limit: 3 }, search.cast, cloudEnv);
    expect(ask.c.searchDecisions).toHaveBeenCalledWith('q', 3);
    expect(search.c.searchDecisions).toHaveBeenCalledWith('q', 3);
  });

  it('says so in the schema, so an agent reading descriptions alone learns they are one tool', () => {
    const search = TOOL_SCHEMAS.find((t) => t.name === 'align_search');
    expect(search).toBeDefined();
    expect(search!.description).toContain('align_ask');
    expect(search!.description.toLowerCase()).toMatch(/alias|same/);
  });
});
