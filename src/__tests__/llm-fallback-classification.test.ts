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

  // A timeout is the most common way the chosen provider fails, and it used to advance:
  // the fetch rejection was indistinguishable from "this provider is not here". Slow is
  // not absent, so it must stop, exactly as the 429 does - the same overloaded provider
  // otherwise stops on a 429 and demotes on a client abort.
  it('a timeout on the chosen provider STOPS the chain, it does not demote', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('OPENAI_API_KEY', 'bait'); // would answer, must not be asked
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('anthropic')) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return openAiResponse('the demotion that must not happen');
    });

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    expect(urls().every(u => u.includes('anthropic'))).toBe(true);
    expect(getLlmFailure()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      detail: 'timed out',
    });
  });

  it('a provider that is genuinely not reachable still advances - the pair for the rule above', async () => {
    // A connection refused or DNS failure means nothing answered, so the next provider
    // may. Only an abort (we gave up on a provider that was answering) is a stop.
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('OPENAI_API_KEY', 'good');
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('anthropic')) throw new TypeError('fetch failed');
      return openAiResponse('next provider answered');
    });

    expect(await callChat('s', 'u')).toBe('next provider answered');
    expect(getLlmFailure()).toBeNull();
  });

  // Once /api/tags has named a model, Ollama is a CHOSEN provider like any other, so a
  // failure from /api/chat must be attributable. It used to record nothing at all, and
  // `align ask` then told a user whose Ollama had just replied to go and set a key.
  it('an Ollama failure after the model was chosen names the model, not "configure a key"', async () => {
    vi.stubEnv('ALIGN_OLLAMA_MODEL', 'llama3.2:latest'); // named, so selection cannot fail
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) }
        : httpError(404, 'model "llama3.2:latest" not found, try pulling it first'));

    const r = await callChat('s', 'u');

    expect(r).toBeNull();
    expect(getLlmFailure()).toEqual({
      provider: 'ollama',
      model: 'llama3.2:latest',
      detail: 'HTTP 404',
    });
  });

  it('Ollama not running at all records nothing - that IS "no provider configured"', async () => {
    // The pair: the /api/tags probe is discovery, so every way IT fails is an absence,
    // and the generic key hint is the right remedy.
    mockFetch.mockImplementation(async () => ({ ok: false, status: 503, text: async () => '' }));

    expect(await callChat('s', 'u')).toBeNull();
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

describe('a reasoning model\'s monologue is not part of the answer (ALI-692)', () => {
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

  // Admitting the deepseek-r reasoning family brought a new output shape with it: r1
  // prefixes its answer with a <think> block. `align ask` prints the response verbatim,
  // and the classifier's brace match would span a brace inside the monologue, so the
  // block has to come off before anyone sees it.
  it('strips a <think> block, keeping the answer that follows it', async () => {
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'deepseek-r1:7b' }] }) }
        : {
          ok: true,
          json: async () => ({
            message: {
              content: '<think>The user asks about Postgres. {maybe JSON?} Let me consider.</think>\n\nPostgres was chosen for JSONB.',
            },
          }),
        });

    const r = await callChat('s', 'u');

    expect(r).toBe('Postgres was chosen for JSONB.');
  });

  it('a monologue with no answer after it is an unusable response, not an answer', async () => {
    // The pair: stripping must not turn "the model only thought" into an empty string
    // presented as prose. It is a stop, and it names the model.
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'deepseek-r1:7b' }] }) }
        : { ok: true, json: async () => ({ message: { content: '<think>I am still thinking.</think>' } }) });

    expect(await callChat('s', 'u')).toBeNull();
    expect(getLlmFailure()).toEqual({
      provider: 'ollama',
      model: 'deepseek-r1:7b',
      detail: 'empty response',
    });
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

  // A dead key that reports itself on a status OUTSIDE 401/403/404 has to advance, or
  // one stale env var in a shell profile permanently disables every provider behind it.
  // Each string below is the provider's real wording.
  it.each([
    ['Gemini, a bad key', 400, 'API key not valid. Please pass a valid API key.'],
    ['a gateway echoing 401 in the body', 500, '{"error":"Unauthorized"}'],
    ['the British spelling', 500, 'request unauthorised'],
    ['OpenAI, a dead account', 429, '{"error":{"code":"insufficient_quota"}}'],
    ['Anthropic, no credit', 400, 'Your credit balance is too low to access the Anthropic API'],
    ['a model rejecting a parameter we always send', 400, "Unsupported parameter: 'max_tokens' is not supported with this model"],
  ])('%s is availability-class: retrying cannot fix it', (_name, status, body) => {
    expect(isAvailabilityFailure(status, body)).toBe(true);
  });

  // The pair for the rule above, and the reason it stays narrow: a TRANSIENT failure
  // must still stop the chain, or widening the allowlist has restored the silent
  // demotion this whole change exists to prevent.
  it.each([
    ['a real rate limit', 429, '{"error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}'],
    ['an overloaded provider', 529, 'Overloaded'],
    ['a gateway timeout', 504, 'upstream timed out'],
    ['a server error', 500, 'internal server error'],
  ])('%s is NOT: it stops the chain', (_name, status, body) => {
    expect(isAvailabilityFailure(status, body)).toBe(false);
  });

  it('the prompt cannot vote: an echoed request body does not authorize advancing', () => {
    // classifyRelationship sends a 2,000-char diff as the user prompt, and endpoints
    // routinely echo the offending request in a 4xx body. Matching bare prose there
    // lets the decision text decide whether to demote to a weaker model.
    const echoed = '{"error":{"code":"context_length_exceeded"},"request":{"messages":'
      + '[{"role":"user","content":"Decision A: Reject unauthorized access. Model not found in the registry"}]}}';
    expect(isAvailabilityFailure(400, echoed)).toBe(false);
  });
});
