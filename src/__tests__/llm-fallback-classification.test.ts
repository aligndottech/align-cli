// ALI-692: the provider fallback chain used to advance on ANY null, so a malformed 200
// from a correctly-authenticated model read the same as a missing key - and both
// silently demoted the call to a weaker model whose answer the caller then trusted as
// if the chosen model wrote it. Now only an availability-class failure (bad key,
// unknown model: the chosen model can NEVER answer here) advances the chain; anything
// else stops it and is recorded so the caller can name the model that failed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callChat,
  getLlmFailure,
  isAvailabilityFailure,
  resetLlmDiagnostics,
} from '../lib/local-llm.js';

const mockFetch = vi.fn();

// Every key the resolver reads, so the host machine's environment cannot decide the
// outcome (same list discipline as ollama-model-floor.test.ts).
const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL',
  'OLLAMA_HOST', 'ALIGN_OLLAMA_MODEL', 'ALIGN_ANTHROPIC_MODEL', 'ALIGN_OPENAI_MODEL',
];

function openAiResponse(text: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}
function httpError(status: number, body = '') {
  return { ok: false, status, text: async () => body };
}

const urls = () => mockFetch.mock.calls.map(c => String(c[0]));

describe('callChat advances only on availability-class failures (ALI-692)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
    resetLlmDiagnostics();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a 401 advances: this key can never work, so the next provider may answer', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'revoked');
    vi.stubEnv('OPENAI_API_KEY', 'good');
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('anthropic') ? httpError(401, 'unauthorized') : openAiResponse('next answer'));

    const r = await callChat('s', 'u');

    expect(r).toBe('next answer');
    expect(getLlmFailure()).toBeNull();
  });

  it('a 404 advances too - the unknown-model shape', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('OPENAI_API_KEY', 'k2');
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('anthropic') ? httpError(404, 'model not found') : openAiResponse('answered'));

    expect(await callChat('s', 'u')).toBe('answered');
    expect(getLlmFailure()).toBeNull();
  });

  it('a 400 whose body names an unknown model advances (body allowlist)', async () => {
    // The shape a generic OpenAI-compatible endpoint produces for a bad model id.
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'https://llm.example.com/v1');
    vi.stubEnv('ALIGN_LLM_MODEL', 'not-installed');
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('/api/tags')
        ? { ok: false }
        : httpError(400, '{"error":{"message":"not-installed is not a valid model ID"}}'));

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    // The chain ADVANCED past the custom endpoint to the Ollama probe...
    expect(urls().some(u => u.includes('/api/tags'))).toBe(true);
    // ...and no stop was recorded: every failure was availability-class.
    expect(getLlmFailure()).toBeNull();
  });

  it('a 200 with no content STOPS the chain and names the model', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('openai.com')
        ? { ok: true, json: async () => ({}) } // authenticated, answered, unusable
        : openAiResponse('a weaker model answer'));

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    // The assertion that separates "stopped" from "silently demoted": nothing after
    // the chosen provider was called - not even the local Ollama probe.
    expect(urls().filter(u => !u.includes('openai.com'))).toEqual([]);
    expect(getLlmFailure()).toEqual({ provider: 'openai', model: 'gpt-4o-mini', detail: 'empty response' });
  });

  it('a 200 whose content is an empty string stops too - the second example of the rule', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    mockFetch.mockImplementation(async () => openAiResponse(''));

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    expect(getLlmFailure()?.detail).toBe('empty response');
  });

  it('a 200 whose body is not JSON stops and says so', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => { throw new Error('bad json'); },
    }));

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    expect(getLlmFailure()).toEqual({ provider: 'openai', model: 'gpt-4o-mini', detail: 'malformed response body' });
  });

  it('a 429 stops: rate-limited is not a licence to demote to a weaker model', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('OPENAI_API_KEY', 'bait'); // would answer, must not be asked
    mockFetch.mockImplementation(async () => httpError(429, 'rate limited'));

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    expect(urls().every(u => u.includes('anthropic'))).toBe(true);
    expect(getLlmFailure()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      detail: 'HTTP 429',
    });
  });

  it('a 500 stops - the second non-availability status', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    mockFetch.mockImplementation(async () => httpError(500, 'internal error'));

    expect(await callChat('s', 'u')).toBeNull();
    expect(getLlmFailure()?.detail).toBe('HTTP 500');
  });

  it('an explicitly configured provider that answers garbage does NOT fall through to env keys', async () => {
    // Distinct values on both sides: the env-keyed provider would answer, and the test
    // is that it is never asked (the old chain fell through here).
    vi.stubEnv('OPENAI_API_KEY', 'bait');
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('anthropic')
        ? { ok: true, json: async () => ({ content: [] }) }
        : openAiResponse('the demotion that must not happen'));

    const r = await callChat('s', 'u', { provider: 'anthropic', apiKey: 'cfg' });

    expect(r).toBeNull();
    expect(urls().every(u => u.includes('anthropic'))).toBe(true);
    expect(getLlmFailure()?.provider).toBe('anthropic');
  });

  it('an explicitly configured provider with a bad key still falls through (availability)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'good');
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('anthropic') ? httpError(401, 'invalid x-api-key') : openAiResponse('env answer'));

    expect(await callChat('s', 'u', { provider: 'anthropic', apiKey: 'revoked' })).toBe('env answer');
  });

  it('a recorded stop describes THIS call, not an earlier one', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    mockFetch.mockImplementation(async () => httpError(429, ''));
    await callChat('s', 'u');
    expect(getLlmFailure()).not.toBeNull();

    mockFetch.mockImplementation(async () => openAiResponse('recovered'));
    const r = await callChat('s', 'u');

    expect(r).toBe('recovered');
    expect(getLlmFailure()).toBeNull();
  });

  it('an Ollama model that answers with nothing is a stop naming that model, not "configure a key"', async () => {
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) }
        : { ok: true, json: async () => ({ message: { content: '' } }) });

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    expect(getLlmFailure()).toEqual({ provider: 'ollama', model: 'llama3.2:latest', detail: 'empty response' });
  });
});

describe('isAvailabilityFailure (the allowlist that authorizes advancing)', () => {
  it.each([[401], [403], [404]])('HTTP %d is availability-class', (status) => {
    expect(isAvailabilityFailure(status, '')).toBe(true);
  });

  it.each([[429], [500], [400]])('HTTP %d alone is not', (status) => {
    expect(isAvailabilityFailure(status, 'something went wrong')).toBe(false);
  });

  it('a body naming an unknown or invalid model is availability-class whatever the status', () => {
    expect(isAvailabilityFailure(400, 'The model `nope` does not exist: model not found')).toBe(true);
    expect(isAvailabilityFailure(400, 'unknown model requested')).toBe(true);
  });
});
