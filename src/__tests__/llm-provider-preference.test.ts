/**
 * A machine can have several providers at once (an ANTHROPIC_API_KEY, an OPENAI_API_KEY, a
 * running Ollama, a saved Groq key). The fixed chain picks the first one it finds; this suite
 * pins the stored preference that lets the user choose, and that a preference never changes
 * the chain's ALI-692 advance rules - it only changes which provider is tried FIRST.
 *
 * Precedence (one place: preferredProvider's docstring in local-llm.ts):
 *   ALIGN_LLM_PROVIDER env  >  config `llm.provider`  >  no preference (the fixed chain)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatDetailed, preferredProvider } from '../lib/local-llm.js';
import { hydrateProviderKeyEnv } from '../lib/config.js';
import { OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL, parseProviderId } from '../lib/llm-providers.js';

const mockFetch = vi.fn();

const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL', 'OLLAMA_HOST',
  'ALIGN_LLM_PROVIDER', 'ALIGN_OPENAI_MODEL', 'ALIGN_GROQ_MODEL', 'ALIGN_ANTHROPIC_MODEL',
];

function openAiResponse(text: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}
function anthropicResponse(text: string) {
  return { ok: true, json: async () => ({ content: [{ text }] }) };
}
const calledUrls = () => mockFetch.mock.calls.map((c) => String(c[0]));

describe('a preferred provider is tried first, and the chain is otherwise unchanged', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('with no preference, Anthropic answers ahead of OpenAI (the fixed chain, as today)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('OPENAI_API_KEY', 'o');
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('anthropic') ? anthropicResponse('from anthropic') : openAiResponse('from openai'));
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: true, text: 'from anthropic' });
  });

  it('ALIGN_LLM_PROVIDER=openai makes OpenAI answer even though Anthropic is configured too', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('OPENAI_API_KEY', 'o');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openai');
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('anthropic') ? anthropicResponse('from anthropic') : openAiResponse('from openai'));
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: true, text: 'from openai' });
    expect(calledUrls()[0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('ALIGN_LLM_PROVIDER=groq outranks even a custom ALIGN_LLM_BASE_URL', async () => {
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'https://custom.example/v1');
    vi.stubEnv('GROQ_API_KEY', 'g');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'groq');
    mockFetch.mockImplementation(async (url: string) =>
      openAiResponse(String(url).includes('groq') ? 'from groq' : 'from custom'));
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: true, text: 'from groq' });
  });

  it('a preferred provider with NO key falls through to the chain exactly as before', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openai'); // no OPENAI_API_KEY
    mockFetch.mockResolvedValue(anthropicResponse('from anthropic'));
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: true, text: 'from anthropic' });
    expect(calledUrls().some((u) => u.includes('openai'))).toBe(false);
  });

  it('a preferred provider that STOPS (a 429) still stops the chain - no weaker model answers (ALI-692)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('OPENAI_API_KEY', 'o');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openai');
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('openai')
        ? { ok: false, status: 429, text: async () => 'slow down' }
        : anthropicResponse('from anthropic'));
    const r = await callChatDetailed('s', 'u');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toMatchObject({ kind: 'provider_stopped', provider: 'openai' });
    expect(calledUrls().some((u) => u.includes('anthropic'))).toBe(false);
  });

  it('a preferred provider that is UNAVAILABLE (a 401) advances to the rest of the chain', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('OPENAI_API_KEY', 'o');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openai');
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('openai')
        ? { ok: false, status: 401, text: async () => 'invalid api key' }
        : anthropicResponse('from anthropic'));
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: true, text: 'from anthropic' });
    // and openai is not asked a second time when the chain reaches its usual slot
    expect(calledUrls().filter((u) => u.includes('openai'))).toHaveLength(1);
  });

  it('ALIGN_LLM_PROVIDER=ollama asks the local model before a configured cloud key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'ollama');
    mockFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:3b' }] }) };
      if (u.endsWith('/api/show')) return { ok: true, json: async () => ({ model_info: { 'llama.context_length': 8192 } }) };
      if (u.endsWith('/api/chat')) return { ok: true, json: async () => ({ message: { content: 'from ollama' } }) };
      return anthropicResponse('from anthropic');
    });
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: true, text: 'from ollama' });
    expect(calledUrls().some((u) => u.includes('anthropic'))).toBe(false);
  });

  it('openrouter is an alias for the custom endpoint slot', () => {
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openrouter');
    expect(preferredProvider()).toBe('custom');
  });

  it('an unknown ALIGN_LLM_PROVIDER warns once and is ignored, rather than failing the call', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'claude-pro-subscription');
    expect(preferredProvider()).toBeUndefined();
    expect(err.mock.calls.join(' ')).toMatch(/ALIGN_LLM_PROVIDER/);
    err.mockRestore();
  });
});

describe('parseProviderId', () => {
  it('accepts every documented id, case-insensitively', () => {
    expect(parseProviderId('OpenAI')).toBe('openai');
    expect(parseProviderId('openrouter')).toBe('openrouter');
    expect(parseProviderId('ollama')).toBe('ollama');
  });
  it('accepts xai as the name people use for grok', () => {
    expect(parseProviderId('xai')).toBe('grok');
  });
  it('rejects anything else', () => {
    expect(parseProviderId('chatgpt')).toBeNull();
    expect(parseProviderId('')).toBeNull();
  });
});

describe('hydrateProviderKeyEnv carries the stored preference and every stored key into env', () => {
  const store = (keys: Record<string, string>, llm?: { provider?: string; model?: string }) => ({
    getProviderKey: (p: string) => keys[p] ?? null,
    getLlmPreference: () => llm ?? {},
  });

  it('a stored preference becomes ALIGN_LLM_PROVIDER when the shell set none', () => {
    const env: Record<string, string | undefined> = {};
    hydrateProviderKeyEnv(store({}, { provider: 'groq' }), env);
    expect(env['ALIGN_LLM_PROVIDER']).toBe('groq');
  });

  it('an exported ALIGN_LLM_PROVIDER beats the stored preference', () => {
    const env: Record<string, string | undefined> = { ALIGN_LLM_PROVIDER: 'openai' };
    hydrateProviderKeyEnv(store({}, { provider: 'groq', model: 'llama-3.3-70b-versatile' }), env);
    expect(env['ALIGN_LLM_PROVIDER']).toBe('openai');
    // the stored model was for groq, and groq is not the preference this run
    expect(env['ALIGN_GROQ_MODEL']).toBeUndefined();
  });

  it('a stored model lands in the preferred provider\'s own model variable', () => {
    const env: Record<string, string | undefined> = {};
    hydrateProviderKeyEnv(store({}, { provider: 'openai', model: 'gpt-4.1' }), env);
    expect(env['ALIGN_OPENAI_MODEL']).toBe('gpt-4.1');
  });

  it('an exported model variable beats the stored model', () => {
    const env: Record<string, string | undefined> = { ALIGN_OPENAI_MODEL: 'gpt-4o' };
    hydrateProviderKeyEnv(store({}, { provider: 'openai', model: 'gpt-4.1' }), env);
    expect(env['ALIGN_OPENAI_MODEL']).toBe('gpt-4o');
  });

  it('hydrates stored keys for providers beyond the Groq/Gemini pair', () => {
    const env: Record<string, string | undefined> = {};
    hydrateProviderKeyEnv(store({ anthropic: 'sk-ant-x', grok: 'xai-y' }), env);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-x');
    expect(env['XAI_API_KEY']).toBe('xai-y');
  });

  it('never shadows a real key exported under an alias (GROK_API_KEY for xAI)', () => {
    const env: Record<string, string | undefined> = { GROK_API_KEY: 'real' };
    hydrateProviderKeyEnv(store({ grok: 'stored' }), env);
    expect(env['XAI_API_KEY']).toBeUndefined();
  });

  it('a stored OpenRouter key becomes the custom endpoint with its base URL and a default model', () => {
    const env: Record<string, string | undefined> = {};
    hydrateProviderKeyEnv(store({ openrouter: 'sk-or-z' }), env);
    expect(env['ALIGN_LLM_BASE_URL']).toBe(OPENROUTER_BASE_URL);
    expect(env['ALIGN_LLM_API_KEY']).toBe('sk-or-z');
    expect(env['ALIGN_LLM_MODEL']).toBe(OPENROUTER_DEFAULT_MODEL);
  });

  it('a stored OpenRouter key never replaces a custom endpoint the shell exported', () => {
    const env: Record<string, string | undefined> = { ALIGN_LLM_BASE_URL: 'http://localhost:8080/v1' };
    hydrateProviderKeyEnv(store({ openrouter: 'sk-or-z' }), env);
    expect(env['ALIGN_LLM_BASE_URL']).toBe('http://localhost:8080/v1');
    expect(env['ALIGN_LLM_API_KEY']).toBeUndefined();
  });

  it('an OpenRouter preference with a stored model uses that model over the default', () => {
    const env: Record<string, string | undefined> = {};
    hydrateProviderKeyEnv(store({ openrouter: 'sk-or-z' }, { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }), env);
    expect(env['ALIGN_LLM_MODEL']).toBe('anthropic/claude-haiku-4.5');
  });
});
