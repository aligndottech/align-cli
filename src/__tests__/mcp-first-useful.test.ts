/**
 * ALI-949: `first_useful_decision` fired from exactly one place - a non-empty `align ask`
 * (why.ts). An agent asking the same question through the local MCP server did not count,
 * so when humans stop typing `align ask` (the point of the phases after this one) the
 * activation stage goes dark exactly when it should light up.
 *
 * createCallToolHandler is the MCP CallTool handler `align mcp` installs, extracted so the
 * emission is testable without an MCP Server. dispatchTool itself stays the pure router.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { createCallToolHandler, type dispatchTool } from '../commands/mcp.js';

type Client = Parameters<typeof dispatchTool>[2];

const env: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };

const HIT = { id: 'd1', title: 'Chose Postgres', summary: 'JSONB', status: 'active', similarity: 0.9 };

function client(over: Partial<Record<'searchDecisions' | 'checkAlignment' | 'getConflicts', unknown>> = {}): Client {
  return {
    searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }),
    checkAlignment: vi.fn().mockResolvedValue({ status: 'no-context', confidence: 0, relevant_decisions: [], message: '' }),
    getConflicts: vi.fn().mockResolvedValue({ links: [{ id: 'l1' }], conflict_count: 1 }),
    ...over,
  } as unknown as Client;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const handler = createCallToolHandler(c, env);
  await handler({ params: { name, arguments: args } });
  // The emission is fire-and-forget (a tool response must not wait on telemetry).
  await new Promise((r) => setImmediate(r));
}

describe('MCP first_useful_decision', () => {
  beforeEach(() => recordFunnelStage.mockReset().mockResolvedValue(true));

  it('align_ask with a non-empty answer records the stage, attributed to mcp', async () => {
    const c = client({ searchDecisions: vi.fn().mockResolvedValue({ results: [HIT], count: 1, strategy: 'semantic' }) });
    await call(c, 'align_ask', { question: 'why postgres' });
    expect(recordFunnelStage).toHaveBeenCalledTimes(1);
    expect(recordFunnelStage).toHaveBeenCalledWith(env, 'first_useful_decision', 'mcp');
  });

  it('align_ask with no results records nothing', async () => {
    await call(client(), 'align_ask', { question: 'why postgres' });
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });

  it('align_search with a hit records the stage', async () => {
    const c = client({ searchDecisions: vi.fn().mockResolvedValue({ results: [HIT], count: 1, strategy: 'keyword' }) });
    await call(c, 'align_search', { query: 'postgres' });
    expect(recordFunnelStage).toHaveBeenCalledWith(env, 'first_useful_decision', 'mcp');
  });

  it('align_search with no hits records nothing', async () => {
    await call(client(), 'align_search', { query: 'postgres' });
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });

  it.each(['aligned', 'conflicting', 'retrieved'] as const)(
    'align_check_alignment that found decisions (%s) records the stage',
    async (status) => {
      const c = client({ checkAlignment: vi.fn().mockResolvedValue({ status, confidence: 0.8, relevant_decisions: [HIT], message: '' }) });
      await call(c, 'align_check_alignment', { diff: '+ x' });
      expect(recordFunnelStage).toHaveBeenCalledWith(env, 'first_useful_decision', 'mcp');
    },
  );

  // A check that could not run is NOT a pass (ALI-414), and it is not a useful decision either.
  it.each(['no-context', 'unknown'] as const)('align_check_alignment with status %s records nothing', async (status) => {
    const c = client({ checkAlignment: vi.fn().mockResolvedValue({ status, confidence: 0, relevant_decisions: [], message: '' }) });
    await call(c, 'align_check_alignment', { diff: '+ x' });
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });

  // Negative control on the tool set: a non-empty result from a tool that is not one of
  // the three "the agent got an answer" tools must not count.
  it('a non-empty align_get_conflicts records nothing', async () => {
    await call(client(), 'align_get_conflicts', {});
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });

  it('still returns the serialized tool result', async () => {
    const c = client({ searchDecisions: vi.fn().mockResolvedValue({ results: [HIT], count: 1, strategy: 'semantic' }) });
    const handler = createCallToolHandler(c, env);
    const res = await handler({ params: { name: 'align_ask', arguments: { question: 'q' } } });
    expect(res.content[0]?.text).toContain('Chose Postgres');
  });
});
