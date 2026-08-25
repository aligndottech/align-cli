import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    searchDecisions: vi.fn().mockResolvedValue({
      results: [
        { id: 'adr-003', title: 'Chose Postgres', summary: 'JSONB and pgvector sealed it.', status: 'active', similarity: 0.91 },
        { id: 'sec-67', title: 'No refresh token DB', summary: 'Client-side only.', status: 'active', similarity: 0.84 },
      ],
      count: 2,
      strategy: 'semantic' as const,
    }),
  })),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn().mockReturnValue({ gatewayUrl: 'http://localhost', authToken: 'tok' }),
    getDefaultEnv: vi.fn().mockReturnValue('prod'),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

// Default null = no AI provider available -> list fallback (keeps the list-rendering tests valid).
const mockSynthesise = vi.hoisted(() => vi.fn().mockResolvedValue(null));
// ALI-420: `ask` asks WHY there was no answer so it can say something useful. Default
// null = the ordinary "no provider configured" case, which keeps the existing tests valid.
const mockUnvetted = vi.hoisted(() => vi.fn().mockReturnValue(null));
vi.mock('../lib/local-llm.js', () => ({
  synthesiseLocally: mockSynthesise,
  getUnvettedOllamaModels: mockUnvetted,
  VETTED_OLLAMA_MODELS: ['llama3.2', 'llama3.1'],
}));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });

import { registerAskCommand } from '../commands/why.js';

describe('align ask', () => {
  beforeEach(() => { output.length = 0; });
  afterEach(() => vi.clearAllMocks());

  it('passes the raw question through so the gateway can route it to semantic search', async () => {
    // The gateway's smart-search strategy selector routes natural-language
    // questions to semantic search. Stripping the question word (the old
    // normalisation) turned a question into a long keyword phrase that matched
    // nothing literally, so ask must pass the query through unchanged. See ALI-105.
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','why do we use postgres']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('why do we use postgres', 8);
  });

  it('prints a conversational synthesised answer when an AI provider is available', async () => {
    mockSynthesise.mockResolvedValueOnce('Postgres was chosen for its JSONB and pgvector support.');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);
    expect(output.some(l => l.includes('Postgres was chosen for its JSONB and pgvector support.'))).toBe(true);
    // still cites sources for traceability
    expect(output.some(l => l.toLowerCase().includes('source'))).toBe(true);
    expect(output.some(l => l.includes('adr-003'))).toBe(true);
  });

  it('falls back to the decision list + a hint when no AI provider is configured', async () => {
    mockSynthesise.mockResolvedValueOnce(null);
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);
    // the list still renders
    expect(output.some(l => l.includes('Chose Postgres'))).toBe(true);
    // and a one-line hint about enabling synthesis
    expect(output.some(l => /ANTHROPIC_API_KEY|align config ai|conversational/i.test(l))).toBe(true);
  });

  it('prints decision titles', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.includes('Chose Postgres'))).toBe(true);
  });

  it('prints decision summaries', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.includes('JSONB and pgvector'))).toBe(true);
  });

  it('prints decision IDs for traceability', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.includes('adr-003'))).toBe(true);
  });

  it('shows no-decisions message when graph is empty', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }),
    });
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.toLowerCase().includes('no decisions found'))).toBe(true);
  });

  it('does not strip question prefixes (no normalisation - gateway picks the strategy)', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','do we use postgres']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('do we use postgres', 8);
  });
});

describe('align ask - file path mode', () => {
  beforeEach(() => { output.length = 0; });
  afterEach(() => vi.clearAllMocks());

  it('detects a file path arg and passes it directly to searchDecisions without normalisation', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'src/auth/middleware.ts']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('src/auth/middleware.ts', 8);
  });

  it('shows "Decisions related to <path>" header for file path queries', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'src/auth/middleware.ts']);
    expect(output.some(l => l.includes('Decisions related to') && l.includes('src/auth/middleware.ts'))).toBe(true);
  });

  it('shows file-specific empty state when no decisions found for path', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }),
    });
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'src/auth/middleware.ts']);
    expect(output.some(l => l.includes('src/auth/middleware.ts'))).toBe(true);
  });

  it('treats arg with ./ prefix as file path', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', './src/auth/middleware.ts']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('./src/auth/middleware.ts', 8);
  });

  it('treats arg as file path when existsSync returns true even with no slash', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'Makefile']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('Makefile', 8);
  });

  // ALI-420. These two are a pair: each one's positive assertion is the other's control,
  // so neither negative can pass because the whole block failed to render.
  it('says why there was no answer when Ollama has only unvetted models', async () => {
    mockUnvetted.mockReturnValueOnce(['WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M']);
    const program = new Command();
    registerAskCommand(program);

    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);

    const all = output.join('\n');
    expect(all).toContain('WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M'); // attributable, not mysterious
    expect(all).toContain('ollama pull llama3.2');             // what to do about it
    expect(all).toContain('ALIGN_OLLAMA_MODEL');               // the escape hatch
    expect(all).toContain('Chose Postgres');                   // the ranked list still prints
    // The generic nudge would be wrong here: they have a provider, it is the model.
    expect(all).not.toContain('Set ANTHROPIC_API_KEY');
  });

  it('keeps the generic provider nudge when Ollama is not the reason', async () => {
    const program = new Command();
    registerAskCommand(program);

    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);

    const all = output.join('\n');
    expect(all).toContain('Set ANTHROPIC_API_KEY');
    expect(all).not.toContain('ollama pull');
  });
});

describe('align ask - source attribution parity with the MCP surface (cite/platform/link)', () => {
  // align-stack#1442 added cite to search payloads so consumers COPY citations
  // instead of composing them. The MCP surface uses all of it; this renderer
  // was the one consumer still printing a raw UUID. Same data, every surface.
  const RICH_RESULTS = {
    results: [
      {
        id: 'c2bf5580-bcd3-4cc3-80fc-46c3f8b224c3',
        title: 'Make prod image tags single-writer',
        summary: 'Release workflow commits the tag.',
        status: 'active',
        similarity: 0.93,
        created_at: '2026-08-19T10:00:00Z',
        author: { name: 'Tom' },
        platform: 'github',
        repository: 'aligndottech/align-stack',
        cite: 'align-stack#1656',
        source_url: 'https://github.com/aligndottech/align-stack/pull/1656',
      },
      {
        id: 'a1b2c3d4-0000-4000-8000-000000000000',
        title: 'Ship weekly, decided in standup',
        summary: 'Slack thread consensus.',
        status: 'active',
        similarity: 0.81,
        created_at: '2026-08-12T10:00:00Z',
        platform: 'slack',
        source_url: 'https://acme.slack.com/archives/C1/p123',
        // no cite: a Slack decision has no repo#number form
      },
    ],
    count: 2,
    strategy: 'semantic' as const,
  };

  beforeEach(async () => {
    output.length = 0;
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValue({
      searchDecisions: vi.fn().mockResolvedValue(RICH_RESULTS),
    });
  });
  afterEach(() => vi.clearAllMocks());

  async function runAsk(): Promise<string> {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'how do prod tags update']);
    return output.join('\n');
  }

  it('synthesis sources cite the human-quotable form, never the raw UUID', async () => {
    mockSynthesise.mockResolvedValueOnce('The release workflow is the single writer.');
    const all = await runAsk();
    expect(all).toContain('(align-stack#1656)');
    expect(all).not.toContain('c2bf5580-bcd3-4cc3-80fc-46c3f8b224c3');
  });

  it('synthesis sources carry the platform tag and the source link', async () => {
    mockSynthesise.mockResolvedValueOnce('The release workflow is the single writer.');
    const all = await runAsk();
    expect(all).toContain('[github]');
    expect(all).toContain('https://github.com/aligndottech/align-stack/pull/1656');
  });

  it('says when the answer spans tools - the cross-tool moment, visible in a terminal', async () => {
    mockSynthesise.mockResolvedValueOnce('The release workflow is the single writer.');
    const all = await runAsk();
    expect(all).toMatch(/across .*github.*slack|across .*slack.*github/);
  });

  it('a decision with no cite keeps its id (decisions show needs it) and still shows platform + link', async () => {
    mockSynthesise.mockResolvedValueOnce('The release workflow is the single writer.');
    const all = await runAsk();
    expect(all).toContain('[slack]');
    expect(all).toContain('https://acme.slack.com/archives/C1/p123');
    expect(all).toContain('a1b2c3d4-0000-4000-8000-000000000000');
  });

  it('the list fallback (no AI provider) renders cite and platform too - one contract, both paths', async () => {
    mockSynthesise.mockResolvedValueOnce(null);
    const all = await runAsk();
    expect(all).toContain('(align-stack#1656)');
    expect(all).toContain('[github]');
  });

  it('single-platform results do NOT claim a cross-tool span', async () => {
    // Negative control for the header: the claim must be earned, not decorative.
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValue({
      searchDecisions: vi.fn().mockResolvedValue({
        results: [RICH_RESULTS.results[0]],
        count: 1,
        strategy: 'semantic' as const,
      }),
    });
    mockSynthesise.mockResolvedValueOnce('One platform only.');
    const all = await runAsk();
    expect(all).not.toMatch(/across /);
  });
});

describe('align ask - cite derived client-side when the wire omits it', () => {
  // The prod smart-search response predates cite; the CLI already owns
  // citationFor (its local client uses it), so the renderer derives the
  // human-quotable form from source_url instead of falling back to a UUID.
  beforeEach(async () => {
    output.length = 0;
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValue({
      searchDecisions: vi.fn().mockResolvedValue({
        results: [{
          id: 'c2bf5580-bcd3-4cc3-80fc-46c3f8b224c3',
          title: 'Single source of truth for prod image tags',
          summary: 's', status: 'active', similarity: 0.9,
          platform: 'github',
          source_url: 'https://github.com/aligndottech/align-stack/pull/1582',
          // no cite on the wire - the prod REST path predates align-stack#1442
        }],
        count: 1, strategy: 'semantic' as const,
      }),
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('renders the derived cite, not the UUID', async () => {
    mockSynthesise.mockResolvedValueOnce('Answer.');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'prod tags?']);
    const all = output.join('\n');
    expect(all).toContain('(align-stack#1582)');
    expect(all).not.toContain('c2bf5580-bcd3-4cc3-80fc-46c3f8b224c3');
  });
});
