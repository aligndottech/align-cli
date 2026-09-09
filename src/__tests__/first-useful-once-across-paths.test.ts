/**
 * ALI-949: `first_useful_decision` is once per INSTALL, and there are now two paths that can
 * reach it - a human typing `align ask` and an agent calling `align_ask` over the local MCP
 * server. Both must share the one guard in recordFunnelStage (usage-telemetry.ts), so an
 * install that got its first answer on either path sends exactly one stage event, in
 * whichever order the two paths run.
 *
 * The real emitter runs here against a stateful config fake and a fetch mock; the two
 * producers are the real `ask` command and the real MCP CallTool handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { EnvironmentConfig } from '../lib/config.js';
import type * as LocalLlm from '../lib/local-llm.js';

const HITS = {
  results: [{ id: 'adr-003', title: 'Chose Postgres', summary: 'JSONB and pgvector.', status: 'active', similarity: 0.91 }],
  count: 1,
  strategy: 'semantic' as const,
};

const cloudEnv: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'tok',
  tenantId: 'tenant-1',
  mode: 'auth',
};

// One install's stage record, shared by every createConfigStore() call in this file - the
// property under test is that the guard is per install, not per code path.
const recorded = vi.hoisted(() => new Set<string>());

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn().mockReturnValue(cloudEnv),
    getDefaultEnv: vi.fn().mockReturnValue('prod'),
    getConnectorFields: vi.fn().mockReturnValue(null),
    getTelemetryConsent: vi.fn().mockReturnValue(undefined),
    getInstallId: vi.fn().mockReturnValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    wasFunnelStageRecorded: (stage: string) => recorded.has(stage),
    markFunnelStageRecorded: (stage: string) => { recorded.add(stage); },
  })),
  ALIGN_HOSTED_GATEWAY_URL: 'https://api.align.tech',
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ searchDecisions: vi.fn().mockResolvedValue(HITS) })),
}));
vi.mock('../lib/local-llm.js', async (importActual) => ({
  ...(await importActual<typeof LocalLlm>()),
  synthesiseDetailed: vi.fn().mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } }),
  RECOMMENDED_OLLAMA_PULL: 'llama3.2',
}));
vi.spyOn(console, 'log').mockImplementation(() => undefined);

import { registerAskCommand } from '../commands/why.js';
import { createCallToolHandler } from '../commands/mcp.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function funnelEvents(): string[] {
  return mockFetch.mock.calls
    .map((c) => JSON.parse(String((c[1] as { body?: string } | undefined)?.body ?? '{}')) as { eventName?: string })
    .map((b) => b.eventName ?? '')
    .filter((n) => n.startsWith('cli.funnel.'));
}

async function humanAsk(): Promise<void> {
  const program = new Command();
  registerAskCommand(program);
  await program.parseAsync(['node', 'align', 'ask', 'why postgres']);
  await new Promise((r) => setImmediate(r)); // why.ts fires the stage without awaiting it
}

async function agentAsk(): Promise<void> {
  const { createGatewayClient } = await import('../lib/gateway-client.js');
  const handler = createCallToolHandler(createGatewayClient(cloudEnv), cloudEnv);
  await handler({ params: { name: 'align_ask', arguments: { question: 'why postgres' } } });
  await new Promise((r) => setImmediate(r));
}

describe('first_useful_decision is once per install across `align ask` and the MCP server', () => {
  beforeEach(() => {
    recorded.clear();
    mockFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubEnv('ALIGN_TELEMETRY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('human first, then agent: one event', async () => {
    await humanAsk();
    await agentAsk();
    expect(funnelEvents()).toEqual(['cli.funnel.first_useful_decision']);
  });

  it('agent first, then human: one event', async () => {
    await agentAsk();
    await humanAsk();
    expect(funnelEvents()).toEqual(['cli.funnel.first_useful_decision']);
  });

  // The MCP server's usual home is local mode (a no-account user's agent). The ping goes to
  // the anonymous endpoint, keyed on the installId, with 'mcp' as its provenance command.
  it('an agent asking in LOCAL mode (consent granted) sends the anonymous stage ping once', async () => {
    const { createConfigStore } = await import('../lib/config.js');
    const consented = { ...createConfigStore(), getTelemetryConsent: vi.fn().mockReturnValue('granted') };
    vi.mocked(createConfigStore).mockReturnValue(consented as ReturnType<typeof createConfigStore>);
    const localEnv: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const handler = createCallToolHandler(createGatewayClient(localEnv), localEnv);
    try {
      await handler({ params: { name: 'align_ask', arguments: { question: 'why postgres' } } });
      await handler({ params: { name: 'align_ask', arguments: { question: 'why postgres' } } });
      await new Promise((r) => setImmediate(r));
    } finally {
      vi.mocked(createConfigStore).mockReset();
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe('https://api.align.tech/telemetry/anonymous');
    const body = JSON.parse(String((mockFetch.mock.calls[0]?.[1] as { body: string }).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ command: 'mcp', stage: 'first_useful_decision', installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  });

  // Positive control for the fixture: with nothing recorded yet, each path alone does send.
  it('each path alone sends the event (the fixture can produce one)', async () => {
    await agentAsk();
    expect(funnelEvents()).toEqual(['cli.funnel.first_useful_decision']);
    recorded.clear();
    mockFetch.mockClear();
    await humanAsk();
    expect(funnelEvents()).toEqual(['cli.funnel.first_useful_decision']);
  });
});
