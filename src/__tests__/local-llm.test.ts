import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChat } from '../lib/local-llm.js';

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

  it('an explicitly configured provider (from align setup) wins over env keys', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-openai');
    mockFetch.mockResolvedValue(anthropicResponse('configured'));

    const r = await callChat('s', 'u', { provider: 'anthropic', apiKey: 'cfg-key' });

    expect(r).toBe('configured');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('cfg-key');
  });

  it('returns null when no provider is configured and Ollama is unreachable', async () => {
    mockFetch.mockResolvedValue({ ok: false }); // ollama /api/tags not ok
    const r = await callChat('s', 'u');
    expect(r).toBeNull();
  });
});
