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

// `ask` now gets the answer AND the reason there is none from one returned value, so
// there is one mock instead of three. Default = the ordinary "no provider configured"
// case, which keeps every list-rendering test below valid.
const mockSynthesise = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } }));
// Spread the real module rather than listing exports: a hand-built fake constrains what
// production code may call, so adding one import to why.ts broke 11 tests here that had
// nothing to do with it. Only the network-touching function is replaced.
vi.mock('../lib/local-llm.js', async (importActual) => ({
  ...(await importActual<typeof LocalLlm>()),
  synthesiseDetailed: mockSynthesise,
  RECOMMENDED_OLLAMA_PULL: 'llama3.2',
}));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });

import { registerAskCommand } from '../commands/why.js';
import type * as LocalLlm from '../lib/local-llm.js';

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

  /**
   * `align ask` printed "N decisions in your graph" where N was the number of SEARCH HITS.
   * `align local status` prints the identical sentence with the real graph size (value-rollup),
   * so the same words meant two different things depending on which command you ran.
   *
   * That is not cosmetic. Diagnosing an unrelated CI failure, I read ask's "2 decisions in your
   * graph" against status's "4 decisions in your graph", concluded the two platforms had
   * different graphs, and published two wrong findings off the back of it. A count is only
   * meaningful with its denominator attached.
   */
  it('describes the count it prints as matches, not as the size of the graph', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);

    expect(output.some(l => /decisions? in your graph/i.test(l))).toBe(false);
    // Positive control: it still reports how many it found, so this is a relabel and not a
    // deletion. The shared fixture at the top of this file reports `count: 2`.
    expect(output.some(l => /2 matching decisions/i.test(l))).toBe(true);
  });

  it('prints a conversational synthesised answer when an AI provider is available', async () => {
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'Postgres was chosen for its JSONB and pgvector support.' });
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);
    expect(output.some(l => l.includes('Postgres was chosen for its JSONB and pgvector support.'))).toBe(true);
    // still cites sources for traceability
    expect(output.some(l => l.toLowerCase().includes('source'))).toBe(true);
    expect(output.some(l => l.includes('adr-003'))).toBe(true);
  });

  it('falls back to the decision list + a hint when no AI provider is configured', async () => {
    mockSynthesise.mockResolvedValueOnce({ ok: false, failure: { kind: 'no_provider' } });
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
    mockSynthesise.mockResolvedValueOnce({ ok: false, failure: { kind: 'unrecognised_local_models', models: ['WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M'] } });
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

  // ALI-692: the chain no longer silently demotes to a weaker model when the chosen
  // one answers unusably - so when that happens, say WHICH model failed and how,
  // instead of telling a user with a working key to go configure a key.
  it('names the model when the chain stopped on an unusable answer', async () => {
    mockSynthesise.mockResolvedValueOnce({ ok: false, failure: { kind: 'provider_stopped', provider: 'openai', model: 'gpt-4o-mini', detail: 'empty response' } });
    const program = new Command();
    registerAskCommand(program);

    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);

    const all = output.join('\n');
    expect(all).toContain('gpt-4o-mini');       // attributable, not mysterious
    expect(all).toContain('empty response');    // what it did
    expect(all).toContain('Chose Postgres');    // the ranked list still prints
    // The generic nudge would be wrong here: a provider IS configured and it replied.
    expect(all).not.toContain('Set ANTHROPIC_API_KEY');
  });

  // ALI-766: a configured provider that never answered is not the same as no provider,
  // and the two need opposite remedies. Telling someone who pointed us at DeepSeek to set
  // ANTHROPIC_API_KEY reads as "DeepSeek is not supported", which is false.
  it('names the endpoint that was tried when a configured provider was unreachable', async () => {
    mockSynthesise.mockResolvedValueOnce({
      ok: false,
      failure: {
        kind: 'providers_unavailable',
        tried: [{ provider: 'custom', detail: 'connect ECONNREFUSED 127.0.0.1:443' }],
      },
    });
    const program = new Command();
    registerAskCommand(program);

    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);

    const all = output.join('\n');
    expect(all).toContain('custom');                 // which one was tried
    expect(all).toContain('ECONNREFUSED');           // why it did not answer
    expect(all).toContain('Chose Postgres');         // the ranked list still prints
    // The whole point: this user HAS configured a provider. Sending them to set a key for
    // a different one is the wrong signpost.
    expect(all).not.toContain('Set ANTHROPIC_API_KEY');
  });

  it('lists every configured provider it tried, not just the first', async () => {
    mockSynthesise.mockResolvedValueOnce({
      ok: false,
      failure: {
        kind: 'providers_unavailable',
        tried: [
          { provider: 'custom', detail: 'connect ECONNREFUSED' },
          { provider: 'openai', detail: 'HTTP 401' },
        ],
      },
    });
    const program = new Command();
    registerAskCommand(program);

    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);

    const all = output.join('\n');
    // Named individually rather than counted: "2 providers failed" tells the user nothing
    // they can act on, and which one holds the dead key is the entire question.
    expect(all).toContain('custom');
    expect(all).toContain('openai');
    expect(all).toContain('HTTP 401');
    // An HTTP 401 means the endpoint answered and refused us, so the summary line must not
    // call it unreachable. The first version of this message did, contradicting the very
    // fixture above it - a review bot caught that, not this suite, so it is pinned now.
    expect(all).not.toMatch(/unreachable/i);
  });

  it('keeps the generic provider nudge when Ollama is not the reason', async () => {
    const program = new Command();
    registerAskCommand(program);

    await program.parseAsync(['node', 'align', 'ask', 'why postgres']);

    const all = output.join('\n');
    // The generic nudge still appears; it now names the LOCAL routes too, because
    // telling someone running llama.cpp to set ANTHROPIC_API_KEY reads as "unsupported".
    expect(all).toContain('ANTHROPIC_API_KEY');
    expect(all).toContain('ALIGN_LLM_BASE_URL');
    // Still not the Ollama-specific remedy: that one is for an Ollama that IS running
    // with no recognised model, which is a different situation with a different fix.
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
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'The release workflow is the single writer.' });
    const all = await runAsk();
    expect(all).toContain('(align-stack#1656)');
    expect(all).not.toContain('c2bf5580-bcd3-4cc3-80fc-46c3f8b224c3');
  });

  it('synthesis sources carry the platform tag and the source link', async () => {
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'The release workflow is the single writer.' });
    const all = await runAsk();
    expect(all).toContain('[github]');
    expect(all).toContain('https://github.com/aligndottech/align-stack/pull/1656');
  });

  it('says when the answer spans tools - the cross-tool moment, visible in a terminal', async () => {
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'The release workflow is the single writer.' });
    const all = await runAsk();
    expect(all).toMatch(/across .*github.*slack|across .*slack.*github/);
  });

  it('a decision with no cite keeps its id (decisions show needs it) and still shows platform + link', async () => {
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'The release workflow is the single writer.' });
    const all = await runAsk();
    expect(all).toContain('[slack]');
    expect(all).toContain('https://acme.slack.com/archives/C1/p123');
    expect(all).toContain('a1b2c3d4-0000-4000-8000-000000000000');
  });

  it('the list fallback (no AI provider) renders cite and platform too - one contract, both paths', async () => {
    mockSynthesise.mockResolvedValueOnce({ ok: false, failure: { kind: 'no_provider' } });
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
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'One platform only.' });
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
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'Answer.' });
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'prod tags?']);
    const all = output.join('\n');
    expect(all).toContain('(align-stack#1582)');
    expect(all).not.toContain('c2bf5580-bcd3-4cc3-80fc-46c3f8b224c3');
  });
});

describe('align ask - the fallback derives cites too (one contract means one contract)', () => {
  // Copilot on #124: the derivation lived only in the synthesis path, so prod
  // responses (no cite on the wire) still showed UUIDs in the fallback. The
  // original fallback test used a cite-carrying fixture - the easy side of the
  // boundary - and could not see this.
  it('list fallback derives the cite from source_url when the wire omits it', async () => {
    output.length = 0;
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValue({
      searchDecisions: vi.fn().mockResolvedValue({
        results: [{
          id: 'c2bf5580-bcd3-4cc3-80fc-46c3f8b224c3',
          title: 'Single writer for prod tags', summary: 's', status: 'active',
          similarity: 0.9, platform: 'github',
          source_url: 'https://github.com/aligndottech/align-stack/pull/1582',
        }],
        count: 1, strategy: 'semantic' as const,
      }),
    });
    mockSynthesise.mockResolvedValueOnce({ ok: false, failure: { kind: 'no_provider' } }); // no provider -> list fallback
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'prod tags?']);
    const all = output.join('\n');
    expect(all).toContain('(align-stack#1582)');
    vi.clearAllMocks();
  });
});
