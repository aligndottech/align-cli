/**
 * The Align engine reaches the decision graph through the same router `align mcp` serves, so
 * an agent asking from inside `align` gets exactly the answers an agent asking over MCP gets.
 * The mcp.js boundary is mocked for dispatchTool only: the schemas and the serialiser stay real,
 * because the tools' parameters are read from TOOL_SCHEMAS and the output is serialised the way
 * mcp.ts does it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const dispatchTool = vi.hoisted(() => vi.fn());
const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../commands/mcp.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchTool,
}));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { createGraphTools } from '../lib/agent/graph-tools.js';

const env: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };
const client = { tag: 'client' } as never;
const HIT = { id: 'd1', title: 'Chose Postgres', status: 'active' };
const firstUseful = (): unknown[][] => recordFunnelStage.mock.calls.filter((c) => c[1] === 'first_useful_decision');

function tool(name: string) {
  const t = createGraphTools({ client, env }).find((x) => x.name === name);
  if (!t) throw new Error(`no graph tool named ${name}`);
  return t;
}

describe('graph tools', () => {
  beforeEach(() => {
    dispatchTool.mockReset().mockResolvedValue({ results: [HIT] });
    recordFunnelStage.mockReset().mockResolvedValue(true);
  });

  it('offers exactly the four read tools, each with the MCP schema as its parameters', async () => {
    const tools = createGraphTools({ client, env });
    expect(tools.map((t) => t.name)).toEqual([
      'align_ask', 'align_search', 'align_get_topic_timeline', 'align_get_related_decisions',
    ]);
    const { TOOL_SCHEMAS } = await import('../commands/mcp.js');
    for (const t of tools) {
      const schema = TOOL_SCHEMAS.find((s) => s.name === t.name)!;
      expect(t.parameters).toEqual(schema.inputSchema);
      expect(t.description).toBe(schema.description);
    }
  });

  it('align_ask calls dispatchTool with that name, those args, the client and env, and returns the MCP text', async () => {
    const text = await tool('align_ask').run({ question: 'why postgres' });
    expect(dispatchTool).toHaveBeenCalledWith('align_ask', { question: 'why postgres' }, client, env);
    const { serializeMcpResult } = await import('../commands/mcp.js');
    expect(text).toBe(serializeMcpResult({ results: [HIT] }));
  });

  it('align_get_topic_timeline routes under its own name', async () => {
    dispatchTool.mockResolvedValue({ decisions: [] });
    await tool('align_get_topic_timeline').run({ topic: 'connection pooling', limit: 5 });
    expect(dispatchTool).toHaveBeenCalledWith('align_get_topic_timeline', { topic: 'connection pooling', limit: 5 }, client, env);
  });

  it('a dispatch failure reaches the model as a rejection, not a swallowed string', async () => {
    dispatchTool.mockRejectedValue(new Error('align_ask requires "question".'));
    await expect(tool('align_ask').run({})).rejects.toThrow('requires "question"');
  });

  it('records first_useful_decision once, on the first non-empty answer', async () => {
    const tools = createGraphTools({ client, env });
    const ask = tools.find((t) => t.name === 'align_ask')!;
    dispatchTool.mockResolvedValueOnce({ results: [] });
    await ask.run({ question: 'nothing here' });
    expect(firstUseful()).toHaveLength(0);
    await ask.run({ question: 'why postgres' });
    await ask.run({ question: 'why postgres again' });
    expect(firstUseful()).toHaveLength(1);
    expect(recordFunnelStage).toHaveBeenCalledWith(env, 'first_useful_decision', 'mcp');
  });

  it('does not record it for a result that is not a real answer (a timeline is a follow-up)', async () => {
    dispatchTool.mockResolvedValue({ decisions: [HIT] });
    await tool('align_get_topic_timeline').run({ topic: 'x' });
    expect(firstUseful()).toHaveLength(0);
  });
});
