/**
 * Which model the Align engine runs. The rules that matter:
 *  - a key the user already gave Align (exported or saved) is the key the engine uses, in-process only;
 *  - ALIGN_AGENT_MODEL=provider/id wins over every default;
 *  - NEVER a subscription login: Anthropic forbids Claude subscription login in third-party apps and
 *    the other OAuth providers are partner-only, so no path here may name one.
 * Env is set and unset explicitly (vi.stubEnv(k, undefined) deletes; '' would leave an empty string,
 * a state no real shell has - tdd.md), so a developer's own exported keys cannot leak into a result.
 */
import { getModel } from '@earendil-works/pi-ai/compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ENV_VARS } from '../lib/llm-providers.js';
import { DEFAULT_PI_MODELS, resolvePiModel } from '../lib/agent/engines/pi-models.js';

const OAUTH_PROVIDERS = ['openai-codex', 'openai-chatgpt', 'github-copilot', 'google-gemini-cli', 'google-antigravity'];
const noOllama = async (): Promise<string | null> => null;

beforeEach(() => {
  for (const k of [...PROVIDER_ENV_VARS, 'ALIGN_AGENT_MODEL', 'OLLAMA_HOST']) vi.stubEnv(k, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('default model table', () => {
  it('names a model Pi knows for every entry', () => {
    expect(Object.keys(DEFAULT_PI_MODELS).length).toBeGreaterThan(0);
    for (const [align, { provider, modelId }] of Object.entries(DEFAULT_PI_MODELS)) {
      expect(getModel(provider as never, modelId as never), `${align} -> ${provider}/${modelId}`).toBeDefined();
    }
  });

  it('holds no subscription provider', () => {
    for (const { provider } of Object.values(DEFAULT_PI_MODELS)) expect(OAUTH_PROVIDERS).not.toContain(provider);
  });
});

describe('resolvePiModel', () => {
  it('an exported ANTHROPIC_API_KEY yields anthropic with that key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-one');
    const r = await resolvePiModel({ probeOllama: noOllama });
    expect(r).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', apiKey: 'sk-ant-test-one' });
    expect(r?.label).toBe('Anthropic claude-sonnet-5-5');
  });

  it('an exported OPENAI_API_KEY yields openai with that key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    expect(await resolvePiModel({ probeOllama: noOllama })).toMatchObject({
      provider: 'openai', modelId: DEFAULT_PI_MODELS['openai']!.modelId, apiKey: 'sk-openai-test',
    });
  });

  it('a saved key is used, and maps align ids to Pi ids (gemini -> google)', async () => {
    const r = await resolvePiModel({ saved: { keys: { gemini: 'g-saved' } }, probeOllama: noOllama });
    expect(r).toMatchObject({ provider: 'google', apiKey: 'g-saved' });
  });

  it('the saved preference decides between two keys', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-one');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    const r = await resolvePiModel({ saved: { keys: {}, provider: 'openai' }, probeOllama: noOllama });
    expect(r?.provider).toBe('openai');
  });

  it('never yields a subscription provider, whichever key is present', async () => {
    expect(Object.keys(DEFAULT_PI_MODELS).length).toBeGreaterThan(0);
    for (const id of Object.keys(DEFAULT_PI_MODELS)) {
      const r = await resolvePiModel({ saved: { keys: { [id]: 'k' } }, probeOllama: noOllama });
      expect(r?.provider, id).toBeDefined();
      expect(OAUTH_PROVIDERS).not.toContain(r!.provider);
    }
  });

  it('refuses ALIGN_AGENT_MODEL naming a subscription provider', async () => {
    for (const p of ['openai-codex', 'github-copilot']) {
      vi.stubEnv('ALIGN_AGENT_MODEL', `${p}/some-model`);
      await expect(resolvePiModel({ probeOllama: noOllama })).rejects.toThrow(/subscription/);
    }
  });

  it('ALIGN_AGENT_MODEL overrides the default and the saved preference, with that provider\'s key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-one');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    vi.stubEnv('ALIGN_AGENT_MODEL', 'openai/gpt-5.5');
    expect(await resolvePiModel({ saved: { keys: {}, provider: 'anthropic' }, probeOllama: noOllama }))
      .toMatchObject({ provider: 'openai', modelId: 'gpt-5.5', apiKey: 'sk-openai-test' });
    vi.stubEnv('ALIGN_AGENT_MODEL', 'anthropic/claude-opus-5');
    expect(await resolvePiModel({ probeOllama: noOllama }))
      .toMatchObject({ provider: 'anthropic', modelId: 'claude-opus-5', apiKey: 'sk-ant-test-one' });
  });

  it('an override whose provider has no key says so instead of starting a keyless session', async () => {
    vi.stubEnv('ALIGN_AGENT_MODEL', 'anthropic/claude-opus-5');
    await expect(resolvePiModel({ probeOllama: noOllama })).rejects.toThrow(/no key/i);
  });

  it('falls back to a reachable Ollama, OpenAI-compatible, when no key exists', async () => {
    const r = await resolvePiModel({ probeOllama: async () => 'qwen2.5-coder:7b' });
    expect(r).toMatchObject({ provider: 'ollama', modelId: 'qwen2.5-coder:7b', baseUrl: 'http://localhost:11434/v1' });
    vi.stubEnv('OLLAMA_HOST', 'http://box:9999');
    expect((await resolvePiModel({ probeOllama: async () => 'm' }))?.baseUrl).toBe('http://box:9999/v1');
  });

  it('prefers a key over Ollama, and returns undefined when neither exists', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk-test');
    expect((await resolvePiModel({ probeOllama: async () => 'm' }))?.provider).toBe('groq');
    vi.stubEnv('GROQ_API_KEY', undefined);
    expect(await resolvePiModel({ probeOllama: noOllama })).toBeUndefined();
  });
});
