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
