// ALI-420: `align ask` used whatever model Ollama happened to list first when nothing
// on the preferred list was installed, and a security-tuned model invented a causal link
// between two unrelated decisions. The judgement is pure - given the installed names and
// an optional override, which model may answer - so it is tested here with no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callChat,
  getUnvettedOllamaModels,
  OLLAMA_MODEL_FAMILIES,
  RECOMMENDED_OLLAMA_PULL,
  resetLlmDiagnostics,
  resolveOllamaModel,
} from '../lib/local-llm.js';

// Real Ollama tag names. The unvetted one is the model from the ticket's reproduction.
const PENTEST = 'WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M';
const CODER = 'deepseek-coder-v2:16b';

describe('resolveOllamaModel (ALI-420 floor)', () => {
  it('uses a recognised model when one is installed', () => {
    expect(resolveOllamaModel(['llama3.2:latest'])).toEqual({ ok: true, model: 'llama3.2:latest' });
  });

  it('prefers by OUR family order, not by the order Ollama happens to list', () => {
    // Second example for the same rule. `/api/tags` order is not a preference, so a
    // machine listing mistral first must still get llama3.1 - the earlier family.
    expect(resolveOllamaModel(['mistral:7b', 'llama3.1:8b'])).toEqual({
      ok: true,
      model: 'llama3.1:8b',
    });
  });

  it('refuses when models are installed but none is recognised', () => {
    // THE defect. Previously returned installed[0] and synthesised with it.
    expect(resolveOllamaModel([PENTEST])).toEqual({ ok: false, reason: 'no_recognised_model' });
  });

  it('refuses on a set of several unvetted models', () => {
    expect(resolveOllamaModel([PENTEST, CODER])).toEqual({ ok: false, reason: 'no_recognised_model' });
  });

  it('refuses with no_models when nothing is installed', () => {
    // Distinct from no_recognised_model: the remedy differs, and the caller must not tell a
    // user with an empty Ollama to stop using a model they do not have.
    expect(resolveOllamaModel([])).toEqual({ ok: false, reason: 'no_models' });
  });

  it('an explicit override is used verbatim even though it is unvetted', () => {
    // The user named it, so it is their call - the same contract every other provider in
    // this resolver already has via ALIGN_<PROVIDER>_MODEL.
    expect(resolveOllamaModel([PENTEST], PENTEST)).toEqual({ ok: true, model: PENTEST });
  });

  it('an explicit override beats an installed vetted model', () => {
    expect(resolveOllamaModel(['llama3.2:latest'], CODER)).toEqual({ ok: true, model: CODER });
  });

  // ALI-692: recognition is by FAMILY against the live /api/tags list, not by an
  // exact-version list. The static list refused llama4 the day it shipped, and the
  // 2026-08-25 vetting eval showed the quality lever was the SYSTEM_PROMPT, not which
  // mainstream family answered - so the list's remaining job is "is something
  // recognisable installed", which the live registry answers better.
  it('recognises a family version the static list never knew (the stale-list defect)', () => {
    expect(resolveOllamaModel(['llama4:latest'])).toEqual({ ok: true, model: 'llama4:latest' });
  });

  it('picks the newest installed version within the winning family', () => {
    expect(resolveOllamaModel(['llama3:latest', 'llama4:latest'])).toEqual({
      ok: true,
      model: 'llama4:latest',
    });
  });

  it('compares versions numerically per segment, not as decimals or strings', () => {
    // 3.10 > 3.9 - a float parse or a string sort gets this backwards.
    expect(resolveOllamaModel(['llama3.9:latest', 'llama3.10:latest'])).toEqual({
      ok: true,
      model: 'llama3.10:latest',
    });
  });

  it('recognises deepseek-r1 - vetted by the 2026-08-25 eval, never added to the static list', () => {
    expect(resolveOllamaModel(['deepseek-r1:7b'])).toEqual({ ok: true, model: 'deepseek-r1:7b' });
  });

  it('recognising the r-series does not admit every model of that vendor', () => {
    // The floor is per-family, and a coder model is not a synthesis family.
    expect(resolveOllamaModel([CODER])).toEqual({ ok: false, reason: 'no_recognised_model' });
  });

  it('recognises qwen', () => {
    expect(resolveOllamaModel(['qwen3:8b'])).toEqual({ ok: true, model: 'qwen3:8b' });
  });

  it('the family list is non-empty and the pull hint is itself recognisable', () => {
    // Positive control on the constants the rules above are written against: an empty
    // family list would refuse everything vacuously, and a pull hint outside the
    // families would tell the user to install a model this resolver then refuses.
    expect(OLLAMA_MODEL_FAMILIES.length).toBeGreaterThan(0);
    expect(resolveOllamaModel([`${RECOMMENDED_OLLAMA_PULL}:latest`])).toEqual({
      ok: true,
      model: `${RECOMMENDED_OLLAMA_PULL}:latest`,
    });
    // Negative control: the ALI-420 floor still exists.
    expect(OLLAMA_MODEL_FAMILIES.some(rx => rx.test(PENTEST))).toBe(false);
  });
});

const mockFetch = vi.fn();

// Every key the resolver reads, so the host machine's environment cannot decide the
// outcome. ALIGN_OLLAMA_MODEL is new and belongs here for the same reason: without it,
// anyone who sets that variable turns the refusal tests below green for the wrong reason.
const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL',
  'OLLAMA_HOST', 'ALIGN_OLLAMA_MODEL',
];

/** Serve /api/tags with the given installed models; /api/chat always answers. */
function ollamaWith(installed: string[]) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/tags')) {
      return { ok: true, json: async () => ({ models: installed.map(name => ({ name })) }) };
    }
    return { ok: true, json: async () => ({ message: { content: 'synthesised answer' } }) };
  });
}

const generateCalls = () =>
  mockFetch.mock.calls.filter(c => String(c[0]).includes('/api/chat'));

describe('callChat falls back to Ollama only through the floor (ALI-420)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
    resetLlmDiagnostics();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses to generate at all when the only model is unvetted', async () => {
    ollamaWith([PENTEST]);

    const r = await callChat('sys', 'usr');

    expect(r).toBeNull();
    // The assertion that separates "refused" from "answered badly": a warning-only fix
    // would still have POSTed here and printed prose from the pentest model.
    expect(generateCalls()).toHaveLength(0);
  });

  it('still answers when a vetted model is installed', async () => {
    // The pair for the rule above - proves the floor did not just break synthesis.
    ollamaWith(['llama3.2:latest']);

    const r = await callChat('sys', 'usr');

    expect(r).toBe('synthesised answer');
    expect(JSON.parse(generateCalls()[0][1].body as string).model).toBe('llama3.2:latest');
  });

  it('generates with ALIGN_OLLAMA_MODEL when the user has named one', async () => {
    vi.stubEnv('ALIGN_OLLAMA_MODEL', PENTEST);
    ollamaWith([PENTEST]);

    const r = await callChat('sys', 'usr');

    expect(r).toBe('synthesised answer');
    expect(JSON.parse(generateCalls()[0][1].body as string).model).toBe(PENTEST);
  });

  it('records the unvetted models so a caller can name them', async () => {
    ollamaWith([PENTEST, CODER]);

    await callChat('sys', 'usr');

    expect(getUnvettedOllamaModels()).toEqual([PENTEST, CODER]);
  });

  it('records nothing when a vetted model answered', async () => {
    ollamaWith(['llama3.2:latest']);

    await callChat('sys', 'usr');

    expect(getUnvettedOllamaModels()).toBeNull();
  });

  it('a later attempt does not inherit an earlier refusal', async () => {
    // The recording describes the most recent attempt or it is worse than useless: a
    // stale one makes a later failure with a different cause report the wrong diagnosis.
    // Found by an existing classifier test going red, not by writing this first.
    ollamaWith([PENTEST]);
    await callChat('sys', 'usr');
    expect(getUnvettedOllamaModels()).toEqual([PENTEST]);

    mockFetch.mockResolvedValue({ ok: false }); // Ollama gone on the next call
    await callChat('sys', 'usr');

    expect(getUnvettedOllamaModels()).toBeNull();
  });

  it('records nothing when Ollama has no models at all', async () => {
    // Ticket item 3: existing behaviour unchanged, and the caller must not be told to
    // stop using a model the user does not have.
    ollamaWith([]);

    const r = await callChat('sys', 'usr');

    expect(r).toBeNull();
    expect(getUnvettedOllamaModels()).toBeNull();
  });
});
