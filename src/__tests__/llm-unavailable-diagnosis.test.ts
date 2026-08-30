import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatDetailed } from '../lib/local-llm.js';

/**
 * ALI-766. `no_provider` conflated two situations that need opposite remedies:
 *
 *   - nothing is configured           -> "set a key"
 *   - what you configured did not answer -> "your endpoint is unreachable / your key is dead"
 *
 * A user who deliberately pointed the CLI at DeepSeek, OpenRouter, LM Studio or vLLM and
 * typo'd the URL was told to go and set ANTHROPIC_API_KEY, which reads as "your provider is
 * not supported". It is supported; it just did not answer.
 */
const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL', 'OLLAMA_HOST',
];

const mockFetch = vi.fn();

describe('callChatDetailed: telling "nothing configured" from "nothing answered"', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
    // Default: every host is unreachable, which is also how the Ollama probe behaves on a
    // machine with no Ollama. Individual tests override.
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('names the custom endpoint when it is configured but unreachable', async () => {
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'https://api.deepseek.com');
    vi.stubEnv('ALIGN_LLM_API_KEY', 'sk-test');
    vi.stubEnv('ALIGN_LLM_MODEL', 'deepseek-chat');

    const res = await callChatDetailed('sys', 'user');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.kind).toBe('providers_unavailable');
    if (res.failure.kind !== 'providers_unavailable') return;
    expect(res.failure.tried.map((t) => t.provider)).toContain('custom');
    // The detail is the point: "it did not answer" without saying why is barely better
    // than the key hint it replaces.
    expect(res.failure.tried[0]!.detail).toMatch(/ECONNREFUSED/);
  });

  it('names a configured named provider whose key is rejected', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-dead');
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });

    const res = await callChatDetailed('sys', 'user');
    expect(res.ok).toBe(false);
    if (res.ok || res.failure.kind !== 'providers_unavailable') {
      throw new Error(`expected providers_unavailable, got ${res.ok ? 'ok' : res.failure.kind}`);
    }
    expect(res.failure.tried.map((t) => t.provider)).toContain('openai');
    expect(res.failure.tried[0]!.detail).toMatch(/401/);
  });

  // The regression guard, and the reason this cannot just be "did anything fail": an absent
  // Ollama makes every run look like a failed attempt, and then "set a key" - which is the
  // RIGHT advice for someone who has configured nothing - would never be shown again.
  it('still reports no_provider when nothing is configured and Ollama is absent', async () => {
    const res = await callChatDetailed('sys', 'user');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.kind).toBe('no_provider');
  });

  it('does not count an absent Ollama as a configured provider', async () => {
    vi.stubEnv('OLLAMA_HOST', 'http://localhost:11434');
    const res = await callChatDetailed('sys', 'user');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.kind).toBe('no_provider');
  });

  // ALI-420's diagnosis is more specific and its remedy is the opposite of "your provider is
  // unreachable", so it must keep winning.
  it('lets an unrecognised local model keep precedence', async () => {
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'https://api.deepseek.com');
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'codellama:7b' }] }) };
      }
      throw new Error('connect ECONNREFUSED');
    });

    const res = await callChatDetailed('sys', 'user');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.kind).toBe('unrecognised_local_models');
  });
});
