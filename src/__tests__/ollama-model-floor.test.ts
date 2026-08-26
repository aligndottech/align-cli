// ALI-420: `align ask` used whatever model Ollama happened to list first when nothing
// on the preferred list was installed, and a security-tuned model invented a causal link
// between two unrelated decisions. The judgement is pure - given the installed names and
// an optional override, which model may answer - so it is tested here with no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callChatDetailed,
  type ChatResult,
  OLLAMA_MODEL_FAMILIES,
  RECOMMENDED_OLLAMA_PULL,
  resolveOllamaModel,
} from '../lib/local-llm.js';

// The unrecognised models are RETURNED on the failure now, not read from a getter.
const unrecognisedOf = (r: ChatResult) =>
  !r.ok && r.failure.kind === 'unrecognised_local_models' ? r.failure.models : null;
const textOf = (r: ChatResult) => (r.ok ? r.text : null);

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

  it('recognises a bare family tag with no version in the name', () => {
    // gemma:2b, phi:latest and qwen:7b are all real library tags. A pattern demanding a
    // digit after the family word refuses the mainstream model it claims to recognise.
    expect(resolveOllamaModel(['gemma:2b'])).toEqual({ ok: true, model: 'gemma:2b' });
    expect(resolveOllamaModel(['phi:latest'])).toEqual({ ok: true, model: 'phi:latest' });
  });

  it('recognises a capitalised tag - real tags are not all lowercase', () => {
    expect(resolveOllamaModel(['Llama3.2:latest'])).toEqual({ ok: true, model: 'Llama3.2:latest' });
  });

  it('recognises a family pulled from a HuggingFace path', () => {
    // `ollama pull hf.co/<user>/<repo>` is a mainstream path, and it prefixes the tag.
    // Anchoring at the start of the whole string refuses every model installed that way.
    const hf = 'hf.co/bartowski/Llama-3.3-70B-Instruct-GGUF:Q4_K_M';
    expect(resolveOllamaModel([hf])).toEqual({ ok: true, model: hf });
  });

  // The ALI-420 floor is about what a model was TUNED for, and a family regex alone
  // cannot see that: llama2-uncensored is in the llama family and is the same category
  // as the pentest model from the ticket.
  it.each([
    ['llama2-uncensored:7b'],
    ['qwen3-coder:30b'],
    ['qwen2-math:7b'],
    ['nomic-embed-text:latest'],
  ])('refuses %s even where the family matches - the tuning disqualifies it', (tag) => {
    expect(resolveOllamaModel([tag])).toEqual({ ok: false, reason: 'no_recognised_model' });
  });

  it('a disqualified model never wins over an installed general one', () => {
    // The sharp version: family order puts llama before mistral, so a bare family match
    // would hand synthesis to the uncensored model while a vetted mistral sat installed.
    expect(resolveOllamaModel(['llama2-uncensored:7b', 'mistral:7b'])).toEqual({
      ok: true,
      model: 'mistral:7b',
    });
  });

  it('reads the version, not the parameter count, when both are in the name', () => {
    // mistral-7b-instruct is a community tag whose only number is its parameter size.
    // Taking the first digit run makes a 7B look newer than Mistral Small 3.1.
    expect(resolveOllamaModel(['mistral-7b-instruct:latest', 'mistral-small3.1:24b'])).toEqual({
      ok: true,
      model: 'mistral-small3.1:24b',
    });
  });

  it('breaks a version tie deterministically, never by /api/tags order', () => {
    // llama3.2:1b and llama3.2:3b tie on version, and a stable sort then lets Ollama's
    // listing order pick the model - the ALI-420 defect one scope down. The same set in
    // either order must give the same answer, and it must be the larger model.
    const forward = resolveOllamaModel(['llama3.2:1b', 'llama3.2:3b']);
    const reverse = resolveOllamaModel(['llama3.2:3b', 'llama3.2:1b']);
    expect(forward).toEqual(reverse);
    expect(forward).toEqual({ ok: true, model: 'llama3.2:3b' });
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
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses to generate at all when the only model is unvetted', async () => {
    ollamaWith([PENTEST]);

    const r = await callChatDetailed('sys', 'usr');

    expect(textOf(r)).toBeNull();
    // The assertion that separates "refused" from "answered badly": a warning-only fix
    // would still have POSTed here and printed prose from the pentest model.
    expect(generateCalls()).toHaveLength(0);
  });

  it('still answers when a vetted model is installed', async () => {
    // The pair for the rule above - proves the floor did not just break synthesis.
    ollamaWith(['llama3.2:latest']);

    const r = await callChatDetailed('sys', 'usr');

    expect(textOf(r)).toBe('synthesised answer');
    expect(JSON.parse(generateCalls()[0][1].body as string).model).toBe('llama3.2:latest');
  });

  it('generates with ALIGN_OLLAMA_MODEL when the user has named one', async () => {
    vi.stubEnv('ALIGN_OLLAMA_MODEL', PENTEST);
    ollamaWith([PENTEST]);

    const r = await callChatDetailed('sys', 'usr');

    expect(textOf(r)).toBe('synthesised answer');
    expect(JSON.parse(generateCalls()[0][1].body as string).model).toBe(PENTEST);
  });

  it('records the unvetted models so a caller can name them', async () => {
    ollamaWith([PENTEST, CODER]);

    const r = await callChatDetailed('sys', 'usr');

    expect(unrecognisedOf(r)).toEqual([PENTEST, CODER]);
  });

  it('records nothing when a vetted model answered', async () => {
    ollamaWith(['llama3.2:latest']);

    const r = await callChatDetailed('sys', 'usr');

    expect(unrecognisedOf(r)).toBeNull();
  });

  it('a later attempt does not inherit an earlier refusal', async () => {
    // Each attempt's diagnosis is on its OWN result, so a refusal cannot outlive its
    // cause and make a later failure report the wrong reason. This used to depend on
    // clearing a module variable at the right moment; now both values coexist and
    // still disagree, which is the same guarantee without the timing.
    ollamaWith([PENTEST]);
    const refused = await callChatDetailed('sys', 'usr');

    mockFetch.mockResolvedValue({ ok: false }); // Ollama gone on the next call
    const gone = await callChatDetailed('sys', 'usr');

    expect(unrecognisedOf(refused)).toEqual([PENTEST]);
    expect(unrecognisedOf(gone)).toBeNull();
  });

  it('records nothing when Ollama has no models at all', async () => {
    // Ticket item 3: existing behaviour unchanged, and the caller must not be told to
    // stop using a model the user does not have.
    ollamaWith([]);

    const r = await callChatDetailed('sys', 'usr');

    expect(textOf(r)).toBeNull();
    expect(unrecognisedOf(r)).toBeNull();
  });
});
