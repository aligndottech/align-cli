// ALI-1494: an opt-in LOCAL trace of the chat calls align makes (ask synthesis, the relationship
// classifier, free-text session confirm - all of them go through callChatDetailed). Off unless
// ALIGN_LLM_TRACE_FILE names a file, written only to that file, and never sent anywhere: the
// docs/telemetry.md promise (no queries or content leave the machine) stays true.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChatDetailed } from '../lib/local-llm.js';

const mockFetch = vi.fn();

const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL',
  'OLLAMA_HOST', 'ALIGN_OLLAMA_MODEL', 'ALIGN_ANTHROPIC_MODEL', 'ALIGN_OPENAI_MODEL',
  'ALIGN_LLM_PROVIDER', 'ALIGN_LLM_TRACE_FILE',
];

function openAiResponse(text: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}

let dir: string;
let traceFile: string;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  // Unset, not empty-string: an env stubbed to '' is a state no real shell produces.
  for (const k of ALL_KEYS) vi.stubEnv(k, undefined);
  dir = mkdtempSync(join(tmpdir(), 'align-trace-'));
  traceFile = join(dir, 'trace.jsonl');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const rows = () =>
  readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('ALIGN_LLM_TRACE_FILE', () => {
  it('is off by default: no file is written when the variable is unset', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    mockFetch.mockResolvedValue(openAiResponse('hello'));

    const r = await callChatDetailed('sys', 'usr');

    expect(r).toEqual({ ok: true, text: 'hello' }); // positive control: the call itself worked
    expect(existsSync(traceFile)).toBe(false);
  });

  it('treats an empty value as off', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', '');
    mockFetch.mockResolvedValue(openAiResponse('hello'));

    await callChatDetailed('sys', 'usr');

    expect(existsSync(traceFile)).toBe(false);
  });

  it('appends one JSON row per call: the system prompt, the user prompt and the answer', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    mockFetch.mockResolvedValueOnce(openAiResponse('first')).mockResolvedValueOnce(openAiResponse('second'));

    await callChatDetailed('sys-1', 'usr-1');
    await callChatDetailed('sys-2', 'usr-2');

    const written = rows();
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ kind: 'chat', system: 'sys-1', user: 'usr-1', ok: true, text: 'first' });
    expect(written[1]).toMatchObject({ system: 'sys-2', user: 'usr-2', text: 'second' });
    expect(Number.isNaN(Date.parse(written[0].ts as string))).toBe(false);
    expect(typeof written[0].durationMs).toBe('number');
  });

  it('records the prompt a callback-form user builder actually produced', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    mockFetch.mockResolvedValue(openAiResponse('ok'));

    await callChatDetailed('sys', (windowTokens) => `built for a window of ${windowTokens > 0 ? 'some' : 'no'} tokens`);

    expect(rows()[0].user).toBe('built for a window of some tokens');
  });

  it('records a failure with its kind instead of an answer', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED')); // no key set, so only the Ollama probe runs

    const r = await callChatDetailed('sys', 'usr');

    expect(r.ok).toBe(false);
    const row = rows()[0];
    expect(row).toMatchObject({ kind: 'chat', ok: false });
    expect(typeof (row.failure as { kind: string }).kind).toBe('string');
    expect(row).not.toHaveProperty('text');
  });

  it('never writes the API key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-never-in-the-trace');
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    mockFetch.mockResolvedValue(openAiResponse('ok'));

    await callChatDetailed('sys', 'usr');

    expect(existsSync(traceFile)).toBe(true); // positive control: a trace was written
    expect(readFileSync(traceFile, 'utf8')).not.toContain('sk-never-in-the-trace');
  });

  it('sends nothing new: the same requests go out with the trace on as with it off', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    mockFetch.mockResolvedValue(openAiResponse('ok'));
    await callChatDetailed('sys', 'usr');
    const without = mockFetch.mock.calls.map((c) => String(c[0]));

    mockFetch.mockClear();
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    await callChatDetailed('sys', 'usr');
    const withTrace = mockFetch.mock.calls.map((c) => String(c[0]));

    expect(without.length).toBeGreaterThan(0);
    expect(withTrace).toEqual(without);
    for (const call of mockFetch.mock.calls) {
      expect(String(call[1]?.body ?? '')).not.toContain('trace.jsonl');
    }
  });

  it.skipIf(process.platform === 'win32')('creates the file readable by its owner only', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    mockFetch.mockResolvedValue(openAiResponse('ok'));

    await callChatDetailed('sys', 'usr');

    expect(statSync(traceFile).mode & 0o777).toBe(0o600);
  });

  it('does not break the call when the file cannot be written', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', join(dir, 'no-such-dir', 'deeper', 'trace.jsonl'));
    mockFetch.mockResolvedValue(openAiResponse('still answered'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const r = await callChatDetailed('sys', 'usr');

    expect(r).toEqual({ ok: true, text: 'still answered' });
    warn.mockRestore();
  });
});
