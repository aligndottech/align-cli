/** An MCP tool call offers one content-free agent_use event: the tool name and the class of the answer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AgentUseModule from '../lib/agent-use-telemetry.js';
import type { EnvironmentConfig } from '../lib/config.js';

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));
const recordAgentUse = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/agent-use-telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentUseModule>()),
  recordAgentUse,
}));

import { createCallToolHandler, type dispatchTool } from '../commands/mcp.js';

type Client = Parameters<typeof dispatchTool>[2];
const env: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };
const client = (over: Record<string, unknown> = {}): Client =>
  ({ getConflicts: vi.fn().mockResolvedValue({ links: [], conflict_count: 0 }), ...over }) as unknown as Client;

async function call(c: Client, name: string, args: Record<string, unknown> = { question: 'SECRET-PROMPT why postgres' }): Promise<void> {
  await createCallToolHandler(c, env)({ params: { name, arguments: args } });
  await new Promise((r) => setImmediate(r));
}

describe('MCP agent_use', () => {
  beforeEach(() => recordAgentUse.mockClear());

  it('a search with results -> related, and exactly via, tool and verdict reach the emitter', async () => {
    await call(client({ searchDecisions: vi.fn().mockResolvedValue({ results: [{ id: 'd1', title: 'SECRET-TITLE' }], count: 1, strategy: 'semantic' }) }), 'align_ask');
    expect(recordAgentUse.mock.calls).toEqual([[env, { via: 'mcp', tool: 'align_ask', verdict: 'related' }]]);
  });

  it('a search with no results -> no_context', async () => {
    await call(client({ searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }) }), 'align_search', { query: 'q' });
    expect(recordAgentUse.mock.calls[0]![1]).toEqual({ via: 'mcp', tool: 'align_search', verdict: 'no_context' });
  });

  it('a conflicts read has no verdict to report -> not_applicable', async () => {
    await call(client(), 'align_get_conflicts');
    expect(recordAgentUse.mock.calls[0]![1]).toEqual({ via: 'mcp', tool: 'align_get_conflicts', verdict: 'not_applicable' });
  });

  it('a call that throws sends nothing', async () => {
    await expect(call(client({ getConflicts: vi.fn().mockRejectedValue(new Error('boom')) }), 'align_get_conflicts')).rejects.toThrow('boom');
    expect(recordAgentUse).not.toHaveBeenCalled();
  });
});
