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
import { callChatDetailed, hasConfiguredProvider, listConfiguredCredentials, preferredProvider, setSavedLlmSource } from '../lib/local-llm.js';
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

  it('openrouter is its own preference, distinct from a custom endpoint', () => {
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openrouter');
    expect(preferredProvider()).toBe('openrouter');
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

/**
 * Saved keys and the saved preference are read INSIDE local-llm (setSavedLlmSource) and never
 * written to process.env: a key in process.env is inherited by the coding agent bare `align`
 * opens, where a saved ANTHROPIC_API_KEY overrides a Claude Max subscription with API billing.
 */
describe('saved keys are resolved inside local-llm, never through process.env', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, undefined);
  });
  afterEach(() => {
    setSavedLlmSource(() => ({ keys: {} }));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a saved Anthropic key answers `align ask`, and process.env never gains it', async () => {
    setSavedLlmSource(() => ({ keys: { anthropic: 'sk-ant-saved' } }));
    mockFetch.mockResolvedValue(anthropicResponse('from saved anthropic'));
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: true, text: 'from saved anthropic' });
    expect((mockFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers['x-api-key']).toBe('sk-ant-saved');
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('a saved Groq key answers too (second example), and process.env never gains it', async () => {
    setSavedLlmSource(() => ({ keys: { groq: 'gsk_saved' } }));
    mockFetch.mockResolvedValue(openAiResponse('from saved groq'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from saved groq' });
    expect(calledUrls()[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(process.env['GROQ_API_KEY']).toBeUndefined();
  });

  it('an exported key for the same provider beats the saved one', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk_exported');
    setSavedLlmSource(() => ({ keys: { groq: 'gsk_saved' } }));
    mockFetch.mockResolvedValue(openAiResponse('x'));
    await callChatDetailed('s', 'u');
    const auth = (mockFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers['Authorization'];
    expect(auth).toBe('Bearer gsk_exported');
  });

  it('M2: any exported credential beats any saved one - saved OpenRouter + exported Anthropic -> Anthropic', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-real');
    setSavedLlmSource(() => ({ keys: { openrouter: 'sk-or-saved' } }));
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('anthropic') ? anthropicResponse('from anthropic') : openAiResponse('from openrouter'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from anthropic' });
  });

  it('M2, second example: saved Anthropic + exported Mistral -> Mistral, though Anthropic is earlier in the order', async () => {
    vi.stubEnv('MISTRAL_API_KEY', 'mis-real');
    setSavedLlmSource(() => ({ keys: { anthropic: 'sk-ant-saved' } }));
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('anthropic') ? anthropicResponse('from anthropic') : openAiResponse('from mistral'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from mistral' });
  });

  it('...unless a preference says otherwise: saved preference anthropic beats the exported Mistral', async () => {
    vi.stubEnv('MISTRAL_API_KEY', 'mis-real');
    setSavedLlmSource(() => ({ keys: { anthropic: 'sk-ant-saved' }, provider: 'anthropic' }));
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('anthropic') ? anthropicResponse('from anthropic') : openAiResponse('from mistral'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from anthropic' });
  });

  it('a saved OpenRouter key calls OpenRouter with its own base URL and default model', async () => {
    setSavedLlmSource(() => ({ keys: { openrouter: 'sk-or-saved' } }));
    mockFetch.mockResolvedValue(openAiResponse('from openrouter'));
    await callChatDetailed('s', 'u');
    expect(calledUrls()[0]).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    const body = JSON.parse(String((mockFetch.mock.calls[0]![1] as { body: string }).body));
    expect(body.model).toBe(OPENROUTER_DEFAULT_MODEL);
  });

  it('M1: an exported ALIGN_LLM_BASE_URL takes none of the saved OpenRouter values (model included)', async () => {
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'http://localhost:8080/v1');
    setSavedLlmSource(() => ({ keys: { openrouter: 'sk-or-saved' }, provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }));
    mockFetch.mockResolvedValue(openAiResponse('local'));
    await callChatDetailed('s', 'u');
    expect(calledUrls()).toEqual(['http://localhost:8080/v1/chat/completions']);
    const init = mockFetch.mock.calls[0]![1] as { body: string; headers: Record<string, string> };
    expect(JSON.parse(init.body).model).toBe('gpt-4o-mini');
    expect(init.headers['Authorization']).toBe('Bearer ');
  });

  it('M1, second example: a saved OpenRouter model never lands on the user\'s own endpoint even with ALIGN_LLM_PROVIDER=custom', async () => {
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'https://api.deepseek.com');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'custom');
    setSavedLlmSource(() => ({ keys: { openrouter: 'sk-or-saved' }, provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }));
    mockFetch.mockResolvedValue(openAiResponse('ds'));
    await callChatDetailed('s', 'u');
    expect(JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).model).toBe('gpt-4o-mini');
  });

  it('a saved OpenRouter preference with a saved model uses that model', async () => {
    setSavedLlmSource(() => ({ keys: { openrouter: 'sk-or-saved' }, provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }));
    mockFetch.mockResolvedValue(openAiResponse('x'));
    await callChatDetailed('s', 'u');
    expect(JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).model).toBe('anthropic/claude-haiku-4.5');
  });

  it('the saved preference is used when ALIGN_LLM_PROVIDER is unset', () => {
    setSavedLlmSource(() => ({ keys: {}, provider: 'groq' }));
    expect(preferredProvider()).toBe('groq');
  });

  it('an exported ALIGN_LLM_PROVIDER beats the saved preference', () => {
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openai');
    setSavedLlmSource(() => ({ keys: {}, provider: 'groq' }));
    expect(preferredProvider()).toBe('openai');
  });

  it('a saved model applies to the preferred provider only', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'o');
    setSavedLlmSource(() => ({ keys: {}, provider: 'openai', model: 'gpt-4.1' }));
    mockFetch.mockResolvedValue(openAiResponse('x'));
    await callChatDetailed('s', 'u');
    expect(JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).model).toBe('gpt-4.1');
  });

  it('an exported model variable beats the saved model', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'o');
    vi.stubEnv('ALIGN_OPENAI_MODEL', 'gpt-4o');
    setSavedLlmSource(() => ({ keys: {}, provider: 'openai', model: 'gpt-4.1' }));
    mockFetch.mockResolvedValue(openAiResponse('x'));
    await callChatDetailed('s', 'u');
    expect(JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).model).toBe('gpt-4o');
  });

  it('a saved model for groq does not apply when the shell prefers openai', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'o');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openai');
    setSavedLlmSource(() => ({ keys: {}, provider: 'groq', model: 'llama-3.3-70b-versatile' }));
    mockFetch.mockResolvedValue(openAiResponse('x'));
    await callChatDetailed('s', 'u');
    expect(JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).model).toBe('gpt-4o-mini');
  });

  it('hasConfiguredProvider counts a saved key', () => {
    expect(hasConfiguredProvider()).toBe(false);
    setSavedLlmSource(() => ({ keys: { mistral: 'm' } }));
    expect(hasConfiguredProvider()).toBe(true);
  });

  it('a source that throws reads as nothing saved, never as a crash', async () => {
    setSavedLlmSource(() => { throw new Error('config unreadable'); });
    mockFetch.mockRejectedValue(new Error('no ollama'));
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: false, failure: { kind: 'no_provider' } });
  });

  it('L3: ALIGN_LLM_PROVIDER=ollama with Ollama down names Ollama as tried - not "no provider", so no key offer', async () => {
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'ollama');
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await callChatDetailed('s', 'u');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('providers_unavailable');
      if (r.failure.kind === 'providers_unavailable') expect(r.failure.tried.map((t) => t.provider)).toEqual(['ollama']);
    }
  });

  it('L3 control: with no preference, Ollama down and nothing else is "no provider"', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: false, failure: { kind: 'no_provider' } });
  });

  it('listConfiguredCredentials names each credential and where it came from, exported first', () => {
    vi.stubEnv('OPENAI_API_KEY', 'o');
    setSavedLlmSource(() => ({ keys: { anthropic: 'a', openai: 'stale' } }));
    expect(listConfiguredCredentials()).toEqual([
      { id: 'openai', source: 'env' },
      { id: 'anthropic', source: 'saved' },
    ]);
  });
});
