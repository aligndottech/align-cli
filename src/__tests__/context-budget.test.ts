import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_FALLBACK_WINDOW,
  envOverrideKey,
  longestPrefixMatch,
  OLLAMA_CONTEXT_FLOOR,
  resolveWindow,
  splitBudget,
  WINDOWS,
} from '../lib/context-budget.js';

const ENV_KEYS = [
  'ALIGN_ANTHROPIC_CONTEXT_TOKENS',
  'ALIGN_OPENAI_CONTEXT_TOKENS',
  'ALIGN_GEMINI_CONTEXT_TOKENS',
  'ALIGN_GROQ_CONTEXT_TOKENS',
  'ALIGN_MISTRAL_CONTEXT_TOKENS',
  'ALIGN_GROK_CONTEXT_TOKENS',
  'ALIGN_LLM_CONTEXT_TOKENS',
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe('longestPrefixMatch', () => {
  it('matches a dated model id against its undated table prefix', () => {
    expect(longestPrefixMatch(WINDOWS.anthropic, 'claude-haiku-4-5-20251001')).toEqual([200_000, 64_000]);
  });
  it('returns undefined for no match', () => {
    expect(longestPrefixMatch(WINDOWS.anthropic, 'claude-imaginary-9')).toBeUndefined();
  });
});

// Rule 1 - the window comes from the table, longest-prefix.
describe('rule 1 - table lookup', () => {
  it('A: claude-haiku-4-5-20251001 with no key and no env resolves from the table', async () => {
    const w = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { warn: () => {} });
    expect(w).toEqual({ maxInputTokens: 200_000, maxOutputTokens: 64_000, source: 'table' });
  });

  it('B: an unknown anthropic model falls back to the minimum of the anthropic table, and warns naming the model', async () => {
    const warn = vi.fn();
    const w = await resolveWindow('anthropic', 'claude-imaginary-9', { warn });
    expect(w).toEqual({ maxInputTokens: 200_000, maxOutputTokens: 64_000, source: 'fallback' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude-imaginary-9'));
  });
});

// Rule 2 - precedence is env > models API > table > fallback.
describe('rule 2 - precedence', () => {
  it('A: an env override wins and the Models API is never called', async () => {
    process.env['ALIGN_ANTHROPIC_CONTEXT_TOKENS'] = '50000';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const w = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { apiKey: 'sk-test', warn: () => {} });
    expect(w).toEqual({ maxInputTokens: 50_000, maxOutputTokens: 50_000, source: 'env' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('B: with no env, a live Models API answer wins over the table - deliberately different values', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ max_input_tokens: 777_777, max_output_tokens: 77_777 }), { status: 200 }),
    );
    const w = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { apiKey: 'sk-test', warn: () => {} });
    expect(w).toEqual({ maxInputTokens: 777_777, maxOutputTokens: 77_777, source: 'models_api' });
    expect(w.maxInputTokens).not.toBe(200_000); // the table's answer for this exact model
  });
});

// Rule 3 - an unusable env override warns and falls through, it does not silently apply.
describe('rule 3 - unusable env override', () => {
  it('A: a non-numeric override (a letter O in place of a zero) falls through to the table and warns naming the variable and the string', async () => {
    process.env['ALIGN_ANTHROPIC_CONTEXT_TOKENS'] = '9O000';
    const warn = vi.fn();
    const w = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { warn });
    expect(w).toEqual({ maxInputTokens: 200_000, maxOutputTokens: 64_000, source: 'table' });
    expect(w.source).not.toBe('env');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ALIGN_ANTHROPIC_CONTEXT_TOKENS'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('9O000'));
  });

  it('B: a negative override is not a window either', async () => {
    process.env['ALIGN_ANTHROPIC_CONTEXT_TOKENS'] = '-1';
    const warn = vi.fn();
    const w = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { warn });
    expect(w.source).not.toBe('env');
    expect(warn).toHaveBeenCalled();
  });
});

describe('envOverrideKey', () => {
  it('is provider-keyed for a named provider', () => {
    expect(envOverrideKey('groq')).toBe('ALIGN_GROQ_CONTEXT_TOKENS');
  });
  it('keeps the custom rung\'s existing name', () => {
    expect(envOverrideKey('custom')).toBe('ALIGN_LLM_CONTEXT_TOKENS');
  });
});

describe('providers with no verified table row', () => {
  it('fall through to the ticket\'s conservative group fallback, not a guessed table entry', async () => {
    const w = await resolveWindow('groq', 'llama-3.1-8b-instant', { warn: () => {} });
    expect(w.source).toBe('fallback');
    expect(w.maxInputTokens).toBeLessThanOrEqual(200_000); // conservative, not the largest guess available
  });
  it('ollama and custom use their own literal fallback, not the group one', async () => {
    const custom = await resolveWindow('custom', 'some-local-model', { warn: () => {} });
    expect(custom).toEqual({ maxInputTokens: CUSTOM_FALLBACK_WINDOW, maxOutputTokens: CUSTOM_FALLBACK_WINDOW, source: 'fallback' });
    const ollama = await resolveWindow('ollama', 'some-model', { warn: () => {} });
    expect(ollama.maxInputTokens).toBe(OLLAMA_CONTEXT_FLOOR);
  });
});

// Rule 10 - the resolver never throws on the request path; splitBudget is the one exception.
describe('rule 10 - never throws on the request path', () => {
  it('A: a rejected or timed-out Models API call falls through to the table, nothing throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    await expect(
      resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { apiKey: 'sk-test', warn: () => {} }),
    ).resolves.toEqual({ maxInputTokens: 200_000, maxOutputTokens: 64_000, source: 'table' });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(
      resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { apiKey: 'sk-test', warn: () => {} }),
    ).resolves.toEqual({ maxInputTokens: 200_000, maxOutputTokens: 64_000, source: 'table' });
  });

  it('B: splitBudget throws when the reservation leaves nothing for the prompt', () => {
    expect(() => splitBudget({ maxInputTokens: 100, maxOutputTokens: 50, source: 'table' }, 4_096)).toThrow();
  });
});
