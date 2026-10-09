/**
 * The providers added from pi-ai 0.87.1's table (MIT; env var, base URL, API shape, model ids)
 * plus DashScope from Alibaba's own docs. Each one: answers from its own env var at the EXACT
 * endpoint, can be preferred, answers from a saved key, and sits AFTER the original seven in
 * the default order, so it only runs when the user has its key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatDetailed, listConfiguredCredentials, setSavedLlmSource } from '../lib/local-llm.js';
import { NAMED_PROVIDERS, PROVIDER_ENV_VARS, STORABLE_PROVIDERS } from '../lib/llm-providers.js';

const mockFetch = vi.fn();

type Row = [id: string, envVar: string, url: string, model: string, shape: 'openai' | 'anthropic'];
const NEW: Row[] = [
  ['deepseek', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/chat/completions', 'deepseek-flash', 'openai'],
  ['zai', 'ZAI_API_KEY', 'https://api.z.ai/api/paas/v4/chat/completions', 'glm-5.3-flash', 'openai'],
  ['moonshotai', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai/v1/chat/completions', 'kimi-k2.6', 'openai'],
  ['cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1/chat/completions', 'gpt-oss-120b', 'openai'],
  ['fireworks', 'FIREWORKS_API_KEY', 'https://api.fireworks.ai/inference/v1/chat/completions', 'accounts/fireworks/models/glm-5p3-flash', 'openai'],
  ['together', 'TOGETHER_API_KEY', 'https://api.together.ai/v1/chat/completions', 'Qwen/Qwen2.5-7B-Instruct-Turbo', 'openai'],
  ['nvidia', 'NVIDIA_API_KEY', 'https://integrate.api.nvidia.com/v1/chat/completions', 'google/gemma-3-12b-it', 'openai'],
  ['huggingface', 'HF_TOKEN', 'https://router.huggingface.co/v1/chat/completions', 'meta-llama/Llama-3.1-8B-Instruct', 'openai'],
  ['baseten', 'BASETEN_API_KEY', 'https://inference.baseten.co/v1/chat/completions', 'deepseek-ai/DeepSeek-V4-Flash-0731', 'openai'],
  ['xiaomi', 'XIAOMI_API_KEY', 'https://api.xiaomimimo.com/v1/chat/completions', 'mimo-v2.5', 'openai'],
  ['qwen', 'DASHSCOPE_API_KEY', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', 'qwen3.5-flash', 'openai'],
  ['qwen-token-plan', 'QWEN_TOKEN_PLAN_API_KEY', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions', 'qwen3.6-flash', 'openai'],
  ['minimax', 'MINIMAX_API_KEY', 'https://api.minimax.io/anthropic/v1/messages', 'MiniMax-M2.7', 'anthropic'],
  ['kimi-coding', 'KIMI_API_KEY', 'https://api.kimi.com/coding/v1/messages', 'kimi-for-coding', 'anthropic'],
  ['vercel-ai-gateway', 'AI_GATEWAY_API_KEY', 'https://ai-gateway.vercel.sh/v1/messages', 'openai/gpt-4o-mini', 'anthropic'],
];

const ok = (shape: 'openai' | 'anthropic', text: string) => ({
  ok: true,
  json: async () => (shape === 'openai' ? { choices: [{ message: { content: text } }] } : { content: [{ text }] }),
});
const call = (n = 0) => mockFetch.mock.calls[n] as [string, { body: string; headers: Record<string, string> }];
const keyHeader = (shape: 'openai' | 'anthropic', h: Record<string, string>) =>
  shape === 'openai' ? h['Authorization'] : h['x-api-key'];

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  for (const v of PROVIDER_ENV_VARS) vi.stubEnv(v, undefined);
  vi.stubEnv('DASHSCOPE_API_KEY', undefined);
  vi.stubEnv('OLLAMA_HOST', undefined);
});
afterEach(() => {
  setSavedLlmSource(() => ({ keys: {} }));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(NEW)('%s', (id, envVar, url, model, shape) => {
  // An exported key alone is only AVAILABLE for these (llm-env-only-providers.test.ts), so each
  // test that exercises the exported key also chooses the provider.
  it(`answers from ${envVar} at the exact endpoint, with its default model, once chosen`, async () => {
    vi.stubEnv(envVar, `key-${id}`);
    vi.stubEnv('ALIGN_LLM_PROVIDER', id);
    mockFetch.mockResolvedValue(ok(shape, `from ${id}`));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: `from ${id}` });
    expect(call()[0]).toBe(url);
    expect(JSON.parse(call()[1].body).model).toBe(model);
    expect(keyHeader(shape, call()[1].headers)).toBe(shape === 'openai' ? `Bearer key-${id}` : `key-${id}`);
  });

  it('can be preferred over an exported Anthropic key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    vi.stubEnv(envVar, `key-${id}`);
    vi.stubEnv('ALIGN_LLM_PROVIDER', id);
    mockFetch.mockImplementation(async (u: string) =>
      u === url ? ok(shape, `from ${id}`) : ok('anthropic', 'from anthropic'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: `from ${id}` });
  });

  it('runs AFTER the original seven: an exported Anthropic key answers first without a preference', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    vi.stubEnv(envVar, `key-${id}`);
    mockFetch.mockImplementation(async (u: string) =>
      u === url ? ok(shape, `from ${id}`) : ok('anthropic', 'from anthropic'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from anthropic' });
  });

  it('answers from a saved key, at the same endpoint', async () => {
    setSavedLlmSource(() => ({ keys: { [id]: `saved-${id}` } }));
    mockFetch.mockResolvedValue(ok(shape, 'x'));
    await callChatDetailed('s', 'u');
    expect(call()[0]).toBe(url);
    expect(keyHeader(shape, call()[1].headers)).toBe(shape === 'openai' ? `Bearer saved-${id}` : `saved-${id}`);
  });

  it('its model variable overrides the default', async () => {
    const p = NAMED_PROVIDERS.find((n) => n.id === id)!;
    vi.stubEnv(envVar, 'k');
    vi.stubEnv('ALIGN_LLM_PROVIDER', id);
    vi.stubEnv(p.modelEnv, 'custom-model-x');
    mockFetch.mockResolvedValue(ok(shape, 'x'));
    await callChatDetailed('s', 'u');
    expect(JSON.parse(call()[1].body).model).toBe('custom-model-x');
  });
});

describe('the provider list', () => {
  it('keeps the original seven first in the key menu, then every new provider', () => {
    expect(STORABLE_PROVIDERS.slice(0, 7)).toEqual(['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'mistral', 'grok']);
    expect(STORABLE_PROVIDERS.slice(7)).toEqual(NEW.map((r) => r[0]));
  });

  it('keeps the original six named providers first in the default order', () => {
    expect(NAMED_PROVIDERS.slice(0, 6).map((p) => p.id)).toEqual(['anthropic', 'openai', 'groq', 'gemini', 'mistral', 'grok']);
  });

  it('every new key variable is one the launcher resets before starting an agent', () => {
    for (const [, envVar] of NEW) expect(PROVIDER_ENV_VARS).toContain(envVar);
  });
});

describe('OpenRouter from an exported OPENROUTER_API_KEY', () => {
  const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

  it('answers at OpenRouter with the default model, once chosen', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openrouter');
    mockFetch.mockResolvedValue(ok('openai', 'from openrouter'));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from openrouter' });
    expect(call()[0]).toBe(OR_URL);
    expect(JSON.parse(call()[1].body).model).toBe('openai/gpt-4o-mini');
    expect(call()[1].headers['Authorization']).toBe('Bearer sk-or-env');
  });

  it('ALIGN_OPENROUTER_MODEL overrides the model', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('ALIGN_OPENROUTER_MODEL', 'anthropic/claude-haiku-4.5');
    mockFetch.mockResolvedValue(ok('openai', 'x'));
    await callChatDetailed('s', 'u');
    expect(JSON.parse(call()[1].body).model).toBe('anthropic/claude-haiku-4.5');
  });

  it('with a saved OpenRouter key too, the exported key is the one sent', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    setSavedLlmSource(() => ({ keys: { openrouter: 'sk-or-saved' } }));
    mockFetch.mockResolvedValue(ok('openai', 'x'));
    await callChatDetailed('s', 'u');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(call()[1].headers['Authorization']).toBe('Bearer sk-or-env');
  });

  it('exported alone is only available: a saved Anthropic key answers, OpenRouter is not called', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    setSavedLlmSource(() => ({ keys: { anthropic: 'sk-ant-saved' } }));
    mockFetch.mockImplementation(async (u: string) => (u === OR_URL ? ok('openai', 'from openrouter') : ok('anthropic', 'from anthropic')));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from anthropic' });
    expect(mockFetch.mock.calls.map((c) => c[0])).not.toContain(OR_URL);
  });

  it('runs after the original six: an exported Anthropic key answers first', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    mockFetch.mockImplementation(async (u: string) => (u === OR_URL ? ok('openai', 'from openrouter') : ok('anthropic', 'from anthropic')));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from anthropic' });
  });

  it('can be preferred over that exported Anthropic key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'openrouter');
    mockFetch.mockImplementation(async (u: string) => (u === OR_URL ? ok('openai', 'from openrouter') : ok('anthropic', 'from anthropic')));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: 'from openrouter' });
  });

  it('a user\'s own ALIGN_LLM_BASE_URL still wins, and OpenRouter is not tried', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'http://localhost:8080/v1');
    mockFetch.mockResolvedValue(ok('openai', 'local'));
    await callChatDetailed('s', 'u');
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual(['http://localhost:8080/v1/chat/completions']);
    expect(listConfiguredCredentials().map((c) => c.id)).toEqual(['custom']);
  });

  it('is listed as an exported credential', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-env');
    expect(listConfiguredCredentials()).toEqual([{ id: 'openrouter', source: 'env' }]);
  });

  it('is one of the variables the launcher resets to the shell\'s own value', () => {
    expect(PROVIDER_ENV_VARS).toContain('OPENROUTER_API_KEY');
    expect(PROVIDER_ENV_VARS).toContain('ALIGN_OPENROUTER_MODEL');
  });
});
