import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalEndpoint, resolveLlmTimeoutMs } from '../lib/local-llm.js';

/**
 * ALI-775. A tester running llama.cpp in podman on CPU got
 *
 *   No answer written: Qwen3.8-27B-IQ2_M.gguf (custom) returned an unusable response
 *   (timed out).
 *
 * His config was correct and the request reached his server. The OpenAI-compatible path -
 * the one docs/configuration.md recommends for LM Studio, vLLM and llama.cpp, all of them
 * local - carried the hosted-API timeout of 15s. A 27B model at IQ2_M on four CPU threads
 * takes minutes. Ollama had already been given 30s for being local; this path never was.
 */
describe('isLocalEndpoint', () => {
  it.each([
    'http://localhost:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
    'http://0.0.0.0:8080/v1',
    'http://192.168.1.50:8080/v1',
    'http://10.0.0.5:1234/v1',
    'http://172.16.4.2:1234/v1',
    'http://host.docker.internal:8080/v1',
    'http://host.containers.internal:8080/v1',
    'http://mybox.local:8080/v1',
  ])('treats %s as local', (url) => {
    expect(isLocalEndpoint(url)).toBe(true);
  });

  it.each([
    'https://api.deepseek.com/v1',
    'https://api.openai.com/v1',
    'https://openrouter.ai/api/v1',
    // 172.32 is OUTSIDE the private range, which stops at 172.31 - the off-by-one a
    // hand-written regex gets wrong, and getting it wrong here means a REMOTE endpoint
    // silently gets a five-minute timeout.
    'http://172.32.0.1:8080/v1',
  ])('treats %s as remote', (url) => {
    expect(isLocalEndpoint(url)).toBe(false);
  });

  it('does not throw on something that is not a URL', () => {
    expect(() => isLocalEndpoint('not a url')).not.toThrow();
    expect(isLocalEndpoint('not a url')).toBe(false);
  });
});

describe('resolveLlmTimeoutMs', () => {
  beforeEach(() => vi.stubEnv('ALIGN_LLM_TIMEOUT_MS', ''));
  afterEach(() => vi.unstubAllEnvs());

  it('gives a local endpoint minutes, not seconds', () => {
    expect(resolveLlmTimeoutMs('http://localhost:8080/v1')).toBeGreaterThanOrEqual(120_000);
  });

  it('keeps a hosted endpoint short, where a long wait really does mean something is wrong', () => {
    expect(resolveLlmTimeoutMs('https://api.deepseek.com/v1')).toBeLessThanOrEqual(30_000);
  });

  it('lets an explicit override win for either', () => {
    vi.stubEnv('ALIGN_LLM_TIMEOUT_MS', '90000');
    expect(resolveLlmTimeoutMs('https://api.deepseek.com/v1')).toBe(90_000);
    expect(resolveLlmTimeoutMs('http://localhost:8080/v1')).toBe(90_000);
  });

  /**
   * A typo'd override must not silently fall back. `Number('9O000')` is NaN, and a NaN
   * timeout would leave the user certain they had raised it while nothing changed - the
   * defaulting-fallback shape this codebase has paid for repeatedly.
   */
  it.each(['', '   ', 'abc', '9O000', '0', '-1', 'NaN'])('ignores an unusable override %p and says so', (bad) => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('ALIGN_LLM_TIMEOUT_MS', bad);
    const ms = resolveLlmTimeoutMs('http://localhost:8080/v1');
    expect(ms).toBeGreaterThanOrEqual(120_000);
    if (bad.trim() !== '') expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
