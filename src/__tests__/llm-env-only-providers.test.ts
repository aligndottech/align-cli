/**
 * A key exported for some OTHER tool must not quietly become align's LLM. HF_TOKEN is exported
 * for model downloads, NVIDIA_API_KEY for NGC tooling, OPENROUTER_API_KEY for whatever else -
 * and before this, `align ask` sent the user's decision text to that provider without asking,
 * and the first-ask key offer never fired.
 *
 * Rule (every provider beyond the original six, OpenRouter included): an exported key alone
 * makes the provider AVAILABLE - `align ai` lists it - but align uses it only when the user
 * saved a key for it, or it is the preference in force (`align ai` or ALIGN_LLM_PROVIDER).
 * The original six (Anthropic, OpenAI, Groq, Gemini, Mistral, xAI) keep using an exported key
 * automatically, as they always have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatDetailed, listConfiguredCredentials, setSavedLlmSource } from '../lib/local-llm.js';
import { PROVIDER_ENV_VARS } from '../lib/llm-providers.js';

const select = vi.hoisted(() => vi.fn());
const password = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', () => ({
  select, password, confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), message: vi.fn() },
}));

import { promptForProviderKey } from '../lib/ask-key-offer.js';

const mockFetch = vi.fn();
const ok = (text: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) });

const CASES: Array<[id: string, envVar: string, label: string, url: string]> = [
  ['huggingface', 'HF_TOKEN', 'Hugging Face', 'https://router.huggingface.co/v1/chat/completions'],
  ['nvidia', 'NVIDIA_API_KEY', 'NVIDIA', 'https://integrate.api.nvidia.com/v1/chat/completions'],
  ['openrouter', 'OPENROUTER_API_KEY', 'OpenRouter', 'https://openrouter.ai/api/v1/chat/completions'],
  ['deepseek', 'DEEPSEEK_API_KEY', 'DeepSeek', 'https://api.deepseek.com/chat/completions'],
];

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  // Nothing on the network: Ollama's probe fails, every other URL answers.
  mockFetch.mockImplementation(async (u: string) => {
    if (String(u).includes('11434')) throw new Error('ECONNREFUSED');
    return ok(`from ${u}`);
  });
  for (const v of PROVIDER_ENV_VARS) vi.stubEnv(v, undefined);
  select.mockReset();
  password.mockReset();
});
afterEach(() => {
  setSavedLlmSource(() => ({ keys: {} }));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(CASES)('%s', (id, envVar, label, url) => {
  it(`exported ${envVar} alone is NOT used: align ask reaches no_provider, so the key offer shows`, async () => {
    vi.stubEnv(envVar, 'exported-for-something-else');
    const r = await callChatDetailed('s', 'u');
    expect(r).toEqual({ ok: false, failure: { kind: 'no_provider' } });
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).not.toContain(url);
  });

  it('...but it is listed as available, from the shell', () => {
    vi.stubEnv(envVar, 'k');
    expect(listConfiguredCredentials()).toEqual([{ id, source: 'env' }]);
  });

  it(`exported + preferred with ALIGN_LLM_PROVIDER -> used`, async () => {
    vi.stubEnv(envVar, 'k');
    vi.stubEnv('ALIGN_LLM_PROVIDER', id);
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: `from ${url}` });
  });

  it('exported + preferred with a saved `align ai` choice -> used', async () => {
    vi.stubEnv(envVar, 'k');
    setSavedLlmSource(() => ({ keys: {}, provider: id }));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: `from ${url}` });
  });

  it('saved key -> used, with no preference', async () => {
    setSavedLlmSource(() => ({ keys: { [id]: 'saved' } }));
    expect(await callChatDetailed('s', 'u')).toEqual({ ok: true, text: `from ${url}` });
  });

  it(`the key menu offers "${label} (found ${envVar} in your shell)", and choosing it saves only the preference`, async () => {
    vi.stubEnv(envVar, 'exported-secret');
    const store = { setProviderKey: vi.fn(), getProviderKey: () => null, setLlmPreference: vi.fn() };
    select.mockImplementationOnce(async (o: { options: Array<{ value: string; label: string }> }) =>
      o.options.find((x) => x.label === `${label} (found ${envVar} in your shell)`)?.value);
    const r = await promptForProviderKey(store);
    expect(r).toBe(id);
    expect(store.setLlmPreference).toHaveBeenCalledWith({ provider: id });
    expect(store.setProviderKey).not.toHaveBeenCalled();
    expect(password).not.toHaveBeenCalled();
  });
});

describe('the original six keep using an exported key automatically', () => {
  it.each([
    ['ANTHROPIC_API_KEY', 'https://api.anthropic.com/v1/messages'],
    ['GROQ_API_KEY', 'https://api.groq.com/openai/v1/chat/completions'],
  ])('%s alone is used', async (envVar, url) => {
    vi.stubEnv(envVar, 'k');
    mockFetch.mockImplementation(async () => ({ ok: true, json: async () => ({ content: [{ text: 'a' }], choices: [{ message: { content: 'a' } }] }) }));
    const r = await callChatDetailed('s', 'u');
    expect(r.ok).toBe(true);
    expect(String(mockFetch.mock.calls[0]![0])).toBe(url);
  });

  it('their exported keys are not offered in the key menu (they are already in use)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('HF_TOKEN', 'k');
    select.mockResolvedValueOnce(undefined);
    await promptForProviderKey({ setProviderKey: vi.fn(), getProviderKey: () => null, setLlmPreference: vi.fn() });
    const labels = (select.mock.calls[0]![0] as { options: Array<{ label: string }> }).options.map((o) => o.label);
    expect(labels).toContain('Hugging Face (found HF_TOKEN in your shell)');
    expect(labels.some((l) => l.includes('ANTHROPIC_API_KEY'))).toBe(false);
  });
});

describe('Qwen: Model Studio (DashScope) and the Token Plan are separate providers', () => {
  it('a saved Qwen key (the paste flow) goes to the DashScope international endpoint', async () => {
    setSavedLlmSource(() => ({ keys: { qwen: 'sk-ds' } }));
    await callChatDetailed('s', 'u');
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).model).toBe('qwen3.5-flash');
  });

  it('a saved Token Plan key goes to the token-plan host', async () => {
    setSavedLlmSource(() => ({ keys: { 'qwen-token-plan': 'tp' } }));
    await callChatDetailed('s', 'u');
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  });
});

describe('an unknown ALIGN_LLM_PROVIDER warns once per process, not once per call', () => {
  it('two calls, one warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'not-a-provider-xyz');
    await callChatDetailed('s', 'u');
    await callChatDetailed('s', 'u');
    expect(err.mock.calls.filter((c) => String(c[0]).includes('not-a-provider-xyz'))).toHaveLength(1);
    err.mockRestore();
  });

  it('a different unknown value still gets its own warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('ALIGN_LLM_PROVIDER', 'another-unknown-abc');
    await callChatDetailed('s', 'u');
    expect(err.mock.calls.filter((c) => String(c[0]).includes('another-unknown-abc'))).toHaveLength(1);
    err.mockRestore();
  });
});

describe('the saved config is read once per LLM call', () => {
  it('one source read for a call that tries several providers', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'o');
    const source = vi.fn(() => ({ keys: { anthropic: 'a', mistral: 'm' }, provider: 'mistral', model: 'mistral-x' }));
    setSavedLlmSource(source);
    await callChatDetailed('s', 'u');
    expect(source).toHaveBeenCalledTimes(1);
  });
});
