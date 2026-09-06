// ALI-845 defect 1: `tryOllama` sent no `num_ctx`, so a chat ran at whatever context the
// Modelfile happens to default to - invisible either way. `/api/show`'s `model_info` names
// the real window; OLLAMA_CONTEXT_LENGTH may only shrink it, never raise it above what the
// model reports (assumption 1 in the plan: a wrong field name here fails quietly, so the
// floor path is required to log - test 4 below pins that).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatDetailed, OLLAMA_CONTEXT_FLOOR, synthesiseDetailed } from '../lib/local-llm.js';
import { estimateTokens } from '../lib/token-estimate.js';

const mockFetch = vi.fn();
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL',
  'OLLAMA_HOST', 'ALIGN_OLLAMA_MODEL', 'OLLAMA_CONTEXT_LENGTH',
];

/** Serve /api/tags with one installed model, /api/show with the given show response, /api/chat generically. */
function ollamaWith(showResponse: { ok: boolean; status?: number; body?: unknown }) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/tags')) {
      return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) };
    }
    if (String(url).includes('/api/show')) {
      return showResponse.ok
        ? { ok: true, json: async () => showResponse.body }
        : { ok: false, status: showResponse.status ?? 500 };
    }
    return { ok: true, json: async () => ({ message: { content: 'synthesised answer' } }) };
  });
}

const chatBody = () => {
  const call = mockFetch.mock.calls.find(c => String(c[0]).includes('/api/chat'));
  return JSON.parse(call![1].body as string);
};

describe('resolveOllamaWindow via tryOllama (ALI-845 defect 1)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    errorSpy.mockClear();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends the reported context_length as num_ctx', async () => {
    ollamaWith({ ok: true, body: { model_info: { 'llama.context_length': 8192 } } });

    await callChatDetailed('sys', 'usr');

    expect(chatBody().options.num_ctx).toBe(8192);
  });

  it('OLLAMA_CONTEXT_LENGTH caps a larger reported window', async () => {
    vi.stubEnv('OLLAMA_CONTEXT_LENGTH', '32768');
    ollamaWith({ ok: true, body: { model_info: { 'llama.context_length': 131072 } } });

    await callChatDetailed('sys', 'usr');

    expect(chatBody().options.num_ctx).toBe(32768);
  });

  // The negative half of the rule above: without it, a Math.max typo passes the same as
  // Math.min. OLLAMA_CONTEXT_LENGTH may only shrink the window, never raise it.
  it('OLLAMA_CONTEXT_LENGTH does not raise the window above what the model reports', async () => {
    vi.stubEnv('OLLAMA_CONTEXT_LENGTH', '262144');
    ollamaWith({ ok: true, body: { model_info: { 'llama.context_length': 131072 } } });

    await callChatDetailed('sys', 'usr');

    expect(chatBody().options.num_ctx).toBe(131072);
  });

  it('falls back to the floor and LOGS the reason when /api/show fails', async () => {
    ollamaWith({ ok: false, status: 404 });

    await callChatDetailed('sys', 'usr');

    expect(chatBody().options.num_ctx).toBe(OLLAMA_CONTEXT_FLOOR);
    // The floor is indistinguishable from a correct small window without this: assumption 1
    // in the plan says a wrong field name fails quietly, so the log is the only visible sign.
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes(String(OLLAMA_CONTEXT_FLOOR)))).toBe(true);
  });

  it('finds a non-llama architecture key (qwen2.context_length)', async () => {
    ollamaWith({ ok: true, body: { model_info: { 'qwen2.context_length': 32768 } } });

    await callChatDetailed('sys', 'usr');

    expect(chatBody().options.num_ctx).toBe(32768);
  });
});

// Regression for a defect found in fresh-context review: buildUserPrompt originally reserved
// the SYNTHESIS_MAX_TOKENS *default* for the output budget, not the value ALIGN_SYNTHESIS_MAX_
// TOKENS actually raises the real request to - so an override could make the sent request
// (prompt + num_predict) exceed the very window it was built against. This combines a SMALL
// real Ollama window with a LARGE override, which a hosted-only test cannot do (the hosted
// default is 100,000 tokens and would mask the bug).
describe('an output-budget override does not push the request over its own window (ALI-845 follow-up)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    errorSpy.mockClear();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reserves the OVERRIDDEN output budget, not the default, when sizing the prompt', async () => {
    vi.stubEnv('ALIGN_SYNTHESIS_MAX_TOKENS', '3000');
    ollamaWith({ ok: true, body: { model_info: { 'llama.context_length': 4096 } } });
    const decisions = Array.from({ length: 4 }, (_, i) => ({
      id: `d${i}`,
      title: `Decision ${i}`,
      summary: 'x'.repeat(2000),
    }));

    await synthesiseDetailed('why?', decisions);

    const body = chatBody();
    expect(body.options.num_predict).toBe(3000);
    const promptTokens = estimateTokens(body.messages[1].content as string);
    // The whole point of this function: prompt + reserved output must fit inside num_ctx.
    // Reserving the 1,024 DEFAULT instead of the 3,000 override (the bug this pins) would
    // let promptTokens alone run past ~3,000, failing this by a wide margin.
    expect(promptTokens + body.options.num_predict).toBeLessThanOrEqual(body.options.num_ctx);
  });
});
