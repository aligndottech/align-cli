/**
 * `align ai`: choose which provider `align ask` writes answers with, when several are
 * available (an exported Anthropic key, a saved Groq key, a running Ollama), or add a key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const select = vi.hoisted(() => vi.fn());
const password = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', () => ({
  select, password, confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), message: vi.fn() },
}));

const probeOllama = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('../lib/local-llm.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeOllama,
}));

const store = vi.hoisted(() => ({
  keys: {} as Record<string, string>,
  llm: {} as { provider?: string; model?: string },
  dismissed: true,
}));
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createConfigStore: () => ({
    getProviderKey: (p: string) => store.keys[p] ?? null,
    setProviderKey: (p: string, k: string) => { store.keys[p] = k; },
    getLlmPreference: () => store.llm,
    setLlmPreference: (v: { provider?: string; model?: string }) => { store.llm = v; },
    clearLlmPreference: () => { store.llm = {}; },
    setAskKeyOfferDismissed: (d: boolean) => { store.dismissed = d; },
  }),
}));

import { registerAiCommand } from '../commands/ai.js';
import { setSavedLlmSource } from '../lib/local-llm.js';

const out: string[] = [];
const errs: string[] = [];

async function ai(...args: string[]) {
  out.length = 0;
  errs.length = 0;
  const program = new Command();
  registerAiCommand(program);
  await program.parseAsync(['node', 'align', 'ai', ...args]);
  return out.join('\n');
}

const setTTY = (v: boolean) => {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
};

const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY',
  'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL'];

beforeEach(() => {
  store.keys = {};
  store.llm = {};
  store.dismissed = true;
  select.mockReset();
  password.mockReset();
  probeOllama.mockResolvedValue(null);
  for (const k of KEYS) vi.stubEnv(k, undefined);
  // What cli.ts's preAction installs in a real run.
  setSavedLlmSource(() => ({ keys: store.keys, ...store.llm }));
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setTTY(false);
});

describe('align ai --provider <id> (any terminal)', () => {
  it('stores the choice', async () => {
    setTTY(false);
    await ai('--provider', 'openai');
    expect(store.llm).toEqual({ provider: 'openai' });
  });

  it('accepts ollama, with a model', async () => {
    setTTY(false);
    await ai('--provider', 'Ollama', '--model', 'qwen3:8b');
    expect(store.llm).toEqual({ provider: 'ollama', model: 'qwen3:8b' });
  });

  it('auto clears the choice, back to the default order', async () => {
    store.llm = { provider: 'groq' };
    await ai('--provider', 'auto');
    expect(store.llm).toEqual({});
  });

  it('an unknown id fails and lists every valid one', async () => {
    await expect(ai('--provider', 'chatgpt')).rejects.toThrow('exit 1');
    const e = errs.join('\n');
    expect(e).toContain('chatgpt');
    for (const id of ['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'mistral', 'grok', 'custom', 'ollama', 'auto']) {
      expect(e).toContain(id);
    }
    expect(store.llm).toEqual({});
  });

  it('L4: a provider with no key is still saved, with a note on how to add one', async () => {
    setTTY(false);
    const text = await ai('--provider', 'openai');
    expect(store.llm).toEqual({ provider: 'openai' });
    expect(text).toContain('No OpenAI key found yet - add one with: align ai');
  });

  it('L4: a provider WITH a key gets no such note', async () => {
    setTTY(false);
    store.keys = { openai: 'sk-o' };
    const text = await ai('--provider', 'openai');
    expect(text).not.toContain('No OpenAI key');
  });

  it('L4: preferring Ollama when it is not running says so', async () => {
    setTTY(false);
    const text = await ai('--provider', 'ollama');
    expect(store.llm).toEqual({ provider: 'ollama' });
    expect(text).toMatch(/Ollama is not running here/);
  });

  it('--model without --provider is refused rather than guessed', async () => {
    await expect(ai('--model', 'gpt-4.1')).rejects.toThrow('exit 1');
    expect(store.llm).toEqual({});
  });
});

describe('align ai on a terminal lists what it detects', () => {
  it('offers each available provider marked with where it came from, plus "Add another key..."', async () => {
    setTTY(true);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-real');
    store.keys = { groq: 'gsk_saved' };
    probeOllama.mockResolvedValue('llama3.2:3b');
    select.mockResolvedValueOnce('groq');
    await ai();
    const opts = select.mock.calls[0]![0] as { options: Array<{ value: string; label: string; hint?: string }> };
    const rows = opts.options.map((o) => `${o.value}|${o.label}|${o.hint ?? ''}`);
    expect(rows).toEqual(expect.arrayContaining([
      expect.stringMatching(/^anthropic\|Anthropic\|env/),
      expect.stringMatching(/^groq\|Groq\|saved/),
      expect.stringMatching(/^ollama\|Ollama\|local/),
      expect.stringMatching(/^add\|Add another key\.\.\./),
    ]));
    expect(store.llm).toEqual({ provider: 'groq' });
  });

  it('marks the current choice, and preselects it', async () => {
    setTTY(true);
    vi.stubEnv('OPENAI_API_KEY', 'o');
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    store.llm = { provider: 'openai' };
    select.mockResolvedValueOnce('openai');
    await ai();
    const opts = select.mock.calls[0]![0] as { initialValue: string; options: Array<{ value: string; hint?: string }> };
    expect(opts.initialValue).toBe('openai');
    expect(opts.options.find((o) => o.value === 'openai')?.hint).toMatch(/current/);
  });

  it('"Add another key..." saves the key, makes it the choice, and never prints it', async () => {
    setTTY(true);
    select.mockResolvedValueOnce('add').mockResolvedValueOnce('mistral');
    password.mockResolvedValueOnce('mis-secret-9');
    await ai();
    expect(store.keys['mistral']).toBe('mis-secret-9');
    expect(store.llm).toEqual({ provider: 'mistral' });
    expect(out.join('\n') + errs.join('\n')).not.toContain('mis-secret-9');
  });

  it('adding a key clears the first-ask "Not now", which has nothing left to guard', async () => {
    setTTY(true);
    select.mockResolvedValueOnce('add').mockResolvedValueOnce('openai');
    password.mockResolvedValueOnce('sk-o');
    await ai();
    expect(store.dismissed).toBe(false);
  });

  it('without a terminal it prints what it found and prompts for nothing', async () => {
    setTTY(false);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-real');
    const text = await ai();
    expect(select).not.toHaveBeenCalled();
    expect(text).toContain('Anthropic');
    expect(text).toContain('align ai --provider');
    expect(text).not.toContain('sk-ant-real');
  });

  it('without a terminal and with nothing found, it says so', async () => {
    setTTY(false);
    const text = await ai();
    expect(text).toMatch(/No AI provider found/);
  });
});
