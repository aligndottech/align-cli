import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChat, SYNTHESIS_SYSTEM_PROMPT, synthesiseDetailed } from '../lib/local-llm.js';

const mockFetch = vi.fn();

// OpenAI / OpenAI-compatible (and Groq/Mistral/Grok/custom) response shape
function openAiResponse(text: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}
// Anthropic response shape
function anthropicResponse(text: string) {
  return { ok: true, json: async () => ({ content: [{ text }] }) };
}

const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL', 'OLLAMA_HOST',
];

describe('callChat (provider-agnostic resolver)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, ''); // isolate from the host machine's env
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('ALIGN_LLM_BASE_URL escape hatch wins over named-provider keys and posts there', async () => {
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'https://api.x.ai/v1');
    vi.stubEnv('ALIGN_LLM_API_KEY', 'xai-key');
    vi.stubEnv('ALIGN_LLM_MODEL', 'grok-2-latest');
    vi.stubEnv('ANTHROPIC_API_KEY', 'should-be-ignored');
    mockFetch.mockResolvedValue(openAiResponse('hatch answer'));

    const r = await callChat('sys', 'usr');

    expect(r).toBe('hatch answer');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('grok-2-latest');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer xai-key');
  });

  it('supports Grok (xAI) via GROK_API_KEY -> api.x.ai', async () => {
    vi.stubEnv('GROK_API_KEY', 'grok-k');
    mockFetch.mockResolvedValue(openAiResponse('grok answer'));

    const r = await callChat('s', 'u');

    expect(r).toBe('grok answer');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
  });

  it('prefers Anthropic over OpenAI when both keys are present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('OPENAI_API_KEY', 'o');
    mockFetch.mockResolvedValue(anthropicResponse('anthropic answer'));

    const r = await callChat('s', 'u');

    expect(r).toBe('anthropic answer');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('returns null when no provider is configured and Ollama is unreachable', async () => {
    mockFetch.mockResolvedValue({ ok: false }); // ollama /api/tags not ok
    const r = await callChat('s', 'u');
    expect(r).toBeNull();
  });
});

describe('SYNTHESIS_SYSTEM_PROMPT carries the abstention contract (ollama-vet eval, 2026-08-25)', () => {
  // Measured: with no abstention instruction, ALL of llama3.2, deepseek-r1 and
  // WhiteRabbitNeo fabricated a database-sharding decision on 6 of 6 runs when
  // asked about something the context did not contain - and "authoritative"
  // in the prompt is what they were obeying. The instruction is pinned here
  // the way a render contract is (ALI-586): a prompt edit that drops the
  // abstention line must go red, because the eval that catches it costs three
  // model runs and this test costs milliseconds.
  it('tells the model to say when the context has no answer, and never to invent', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/does not (answer|contain|cover)/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/never (guess|invent)/i);
  });

  it('tells the model to surface contradictions rather than pick a winner', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT.toLowerCase()).toContain('conflict');
  });

  it('no longer says "authoritative" - the measured licence to confabulate', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT.toLowerCase()).not.toContain('authoritative');
    // Positive control for the negative assertion: the constant is real prose,
    // not an empty string a broken import would also satisfy.
    expect(SYNTHESIS_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  // Found live 2026-09-02: `align ask` synthesised an answer containing an em-dash
  // (mirroring the punctuation of the source Confluence content it was summarising) -
  // the same tell code-style.md bans in everything WE write, now showing up in
  // something the MODEL writes on our behalf. The prompt never said anything about
  // punctuation, so the model was free to copy the source's style.
  it('tells the model never to use an em-dash', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/never use an? em-?dash/i);
  });
});

// The prompt instruction above is the ask-nicely layer, and smaller local models
// (the ones David and Tom are actually testing with, via Ollama or a local
// llama.cpp endpoint) are not reliable about following style constraints. code-
// style.md treats "no em-dash" as a hard rule for everything WE write, not a
// preference to re-litigate - the model-generated surface a user actually reads
// deserves the same guarantee, not just a request the model can ignore.
describe('synthesiseDetailed strips em-dashes the model used anyway', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('replaces an em-dash the provider returned with the house style', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('Postgres was chosen—concurrent writers mattered.'));

    const result = await synthesiseDetailed('why postgres', []);

    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toBe('Postgres was chosen - concurrent writers mattered.');
  });

  // Positive control for the negative-shaped assertion above: text with no em-dash
  // must survive completely unchanged, or this could be a check that rewrites every
  // answer rather than one that only touches the character in question.
  it('leaves text with no em-dash untouched', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('Postgres was chosen for concurrent writers.'));

    const result = await synthesiseDetailed('why postgres', []);

    expect(result.ok && result.text).toBe('Postgres was chosen for concurrent writers.');
  });
});
