/**
 * The AI-provider key used to be asked for at the END of the first-run wizard, right before
 * align opened Claude Code - so a founder reading it thought the Groq/Gemini keys were for
 * Claude. They are only for align's own terminal `align ask` prose. The ask now happens there,
 * lazily: the first time `align ask` has nothing to write prose with, on a terminal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.hoisted(() => vi.fn());
const password = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
const success = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const CANCEL = vi.hoisted(() => Symbol('cancel'));
vi.mock('@clack/prompts', () => ({
  select, password, confirm,
  isCancel: (v: unknown) => v === CANCEL,
  log: { info, success, warn, message: info },
}));

import { detectProviders, offerAskProviderKey, promptForProviderKey } from '../lib/ask-key-offer.js';
import { OPENROUTER_BASE_URL } from '../lib/llm-providers.js';

function fakeConfig(stored: Record<string, string> = {}) {
  const keys: Record<string, string> = { ...stored };
  let dismissed = false;
  return {
    keys,
    get dismissed() { return dismissed; },
    getProviderKey: vi.fn((p: string) => keys[p] ?? null),
    setProviderKey: vi.fn((p: string, k: string) => { keys[p] = k; }),
    isAskKeyOfferDismissed: () => dismissed,
    setAskKeyOfferDismissed: vi.fn((d: boolean) => { dismissed = d; }),
  };
}

/** Everything any prompt or log line printed, so a test can assert a secret never appears. */
function everythingShown(): string {
  const calls = [select, password, confirm, info, success, warn].flatMap((f) => f.mock.calls);
  return JSON.stringify(calls);
}

beforeEach(() => {
  for (const f of [select, password, confirm, info, success, warn]) f.mockReset();
});

describe('the first-ask offer', () => {
  it('explains that the agent does not need it before offering anything, and defaults to "Not now"', async () => {
    select.mockResolvedValueOnce('later');
    await offerAskProviderKey(fakeConfig(), {});
    const shown = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(shown).toContain("align ask writes answers with an AI model. Inside your coding agent you don't need this - the agent writes them.");
    const opts = select.mock.calls[0]![0] as { message: string; options: Array<{ value: string; label: string }>; initialValue: string };
    expect(opts.message).toContain('To get answers here in the terminal, pick one');
    expect(opts.options.map((o) => o.label)).toEqual([
      'Use a key I already have',
      'Get a free Groq key',
      'Not now - just show matching decisions',
    ]);
    expect(opts.initialValue).toBe('later');
  });

  it('names `align ai` as the way back, so "Not now" is not forever', async () => {
    select.mockResolvedValueOnce('later');
    await offerAskProviderKey(fakeConfig(), {});
    expect(everythingShown()).toContain('align ai');
  });

  it('"Not now" is remembered, so the next ask does not ask again', async () => {
    const config = fakeConfig();
    select.mockResolvedValueOnce('later');
    const r = await offerAskProviderKey(config, {});
    expect(r).toBe('dismissed');
    expect(config.dismissed).toBe(true);
  });

  it('Ctrl-C at the choice is NOT remembered as a decision', async () => {
    const config = fakeConfig();
    select.mockResolvedValueOnce(CANCEL);
    const r = await offerAskProviderKey(config, {});
    expect(r).toBe('cancelled');
    expect(config.dismissed).toBe(false);
  });

  it('"Get a free Groq key" stores the pasted key and makes it usable this run', async () => {
    const config = fakeConfig();
    const env: Record<string, string | undefined> = {};
    select.mockResolvedValueOnce('groq');
    password.mockResolvedValueOnce('gsk_secret_1');
    confirm.mockResolvedValueOnce(false); // no Gemini backup
    const r = await offerAskProviderKey(config, env);
    expect(r).toBe('configured');
    expect(config.setProviderKey).toHaveBeenCalledWith('groq', 'gsk_secret_1');
    expect(env['GROQ_API_KEY']).toBe('gsk_secret_1');
    expect(everythingShown()).toContain('https://console.groq.com/keys');
    expect(everythingShown()).not.toContain('gsk_secret_1');
  });

  it('the Groq path can add the Gemini backup too, as before', async () => {
    const config = fakeConfig();
    const env: Record<string, string | undefined> = {};
    select.mockResolvedValueOnce('groq');
    password.mockResolvedValueOnce('gsk_secret_1').mockResolvedValueOnce('gem_secret_2');
    confirm.mockResolvedValueOnce(true);
    await offerAskProviderKey(config, env);
    expect(config.setProviderKey).toHaveBeenCalledWith('gemini', 'gem_secret_2');
    expect(env['GEMINI_API_KEY']).toBe('gem_secret_2');
    expect(everythingShown()).not.toContain('gem_secret_2');
  });

  it('an empty paste stores nothing and is not remembered as "Not now"', async () => {
    const config = fakeConfig();
    select.mockResolvedValueOnce('groq');
    password.mockResolvedValueOnce('');
    const r = await offerAskProviderKey(config, {});
    expect(r).toBe('cancelled');
    expect(config.setProviderKey).not.toHaveBeenCalled();
    expect(config.dismissed).toBe(false);
  });
});

describe('"Use a key I already have"', () => {
  it('lists the seven providers a key can be saved for', async () => {
    select.mockResolvedValueOnce('existing').mockResolvedValueOnce('anthropic');
    password.mockResolvedValueOnce('sk-ant-secret');
    await offerAskProviderKey(fakeConfig(), {});
    const labels = (select.mock.calls[1]![0] as { options: Array<{ label: string }> }).options.map((o) => o.label);
    expect(labels).toEqual(['Anthropic', 'OpenAI', 'OpenRouter', 'Gemini', 'Groq', 'Mistral', 'xAI']);
  });

  it.each([
    ['anthropic', 'sk-ant-secret', 'ANTHROPIC_API_KEY'],
    ['openai', 'sk-openai-secret', 'OPENAI_API_KEY'],
    ['gemini', 'gem-secret', 'GEMINI_API_KEY'],
    ['mistral', 'mis-secret', 'MISTRAL_API_KEY'],
    ['grok', 'xai-secret', 'XAI_API_KEY'],
  ])('stores a %s key and hydrates it into its env variable', async (id, key, envVar) => {
    const config = fakeConfig();
    const env: Record<string, string | undefined> = {};
    select.mockResolvedValueOnce(id);
    password.mockResolvedValueOnce(key);
    const r = await promptForProviderKey(config, env);
    expect(r).toBe(id);
    expect(config.setProviderKey).toHaveBeenCalledWith(id, key);
    expect(env[envVar]).toBe(key);
    expect(everythingShown()).not.toContain(key);
  });

  it('an OpenRouter key sets the base URL, the key and a default model', async () => {
    const config = fakeConfig();
    const env: Record<string, string | undefined> = {};
    select.mockResolvedValueOnce('openrouter');
    password.mockResolvedValueOnce('sk-or-secret');
    await promptForProviderKey(config, env);
    expect(config.setProviderKey).toHaveBeenCalledWith('openrouter', 'sk-or-secret');
    expect(env['ALIGN_LLM_BASE_URL']).toBe(OPENROUTER_BASE_URL);
    expect(env['ALIGN_LLM_API_KEY']).toBe('sk-or-secret');
    expect(env['ALIGN_LLM_MODEL']).toBeTruthy();
    expect(everythingShown()).not.toContain('sk-or-secret');
  });
});

describe('detectProviders names every available provider and where it came from', () => {
  const noOllama = async () => null;

  it('an exported key is "env", a saved one is "saved"', async () => {
    const config = fakeConfig({ groq: 'gsk_saved' });
    const env = { ANTHROPIC_API_KEY: 'sk-ant-real', GROQ_API_KEY: 'gsk_saved' };
    const found = await detectProviders(config, env, noOllama);
    expect(found).toEqual([
      { id: 'anthropic', source: 'env' },
      { id: 'groq', source: 'saved' },
    ]);
  });

  it('a running Ollama is "local", and a custom endpoint is listed first', async () => {
    const env = { ALIGN_LLM_BASE_URL: 'http://localhost:8080/v1' };
    const found = await detectProviders(fakeConfig(), env, async () => 'llama3.2:3b');
    expect(found).toEqual([
      { id: 'custom', source: 'env' },
      { id: 'ollama', source: 'local' },
    ]);
  });

  it('a saved OpenRouter key is shown as OpenRouter, not as an anonymous custom endpoint', async () => {
    const config = fakeConfig({ openrouter: 'sk-or-x' });
    const env = { ALIGN_LLM_BASE_URL: OPENROUTER_BASE_URL, ALIGN_LLM_API_KEY: 'sk-or-x' };
    expect(await detectProviders(config, env, noOllama)).toEqual([{ id: 'openrouter', source: 'saved' }]);
  });

  it('nothing configured is an empty list', async () => {
    expect(await detectProviders(fakeConfig(), {}, noOllama)).toEqual([]);
  });
});
