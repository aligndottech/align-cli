/** ALI-2076: every tool call an agent makes through `align mcp` offers the once-a-day agent_active stage. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { createCallToolHandler, type dispatchTool } from '../commands/mcp.js';

type Client = Parameters<typeof dispatchTool>[2];
const env: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };
const client = (over: Record<string, unknown> = {}): Client =>
  ({ getConflicts: vi.fn().mockResolvedValue({ links: [], conflict_count: 0 }), ...over }) as unknown as Client;

async function call(c: Client, name: string): Promise<void> {
  await createCallToolHandler(c, env)({ params: { name, arguments: {} } });
  await new Promise((r) => setImmediate(r));
}
const activeCalls = (): unknown[][] => recordFunnelStage.mock.calls.filter((c) => c[1] === 'agent_active');

describe('MCP agent_active', () => {
  beforeEach(() => recordFunnelStage.mockReset().mockResolvedValue(true));

  it.each(['align_get_conflicts', 'align_stale_code'])('a %s call offers agent_active, attributed to mcp', async (name) => {
    await call(client({ staleCode: vi.fn().mockResolvedValue({}) }), name);
    expect(activeCalls()).toEqual([[env, 'agent_active', 'mcp']]);
  });

  it('a call that throws offers nothing: the agent got no use out of it', async () => {
    const c = client({ getConflicts: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(call(c, 'align_get_conflicts')).rejects.toThrow('boom');
    expect(activeCalls()).toEqual([]);
  });
});
