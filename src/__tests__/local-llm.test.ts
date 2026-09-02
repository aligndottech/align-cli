import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ABSTENTION_SENTINEL,
  callChat,
  isAbstention,
  SYNTHESIS_SYSTEM_PROMPT,
  synthesiseDetailed,
} from '../lib/local-llm.js';

const mockFetch = vi.fn();

// OpenAI / OpenAI-compatible (and Groq/Mistral/Grok/custom) response shape
function openAiResponse(text: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}
// Anthropic response shape
function anthropicResponse(text: string) {
  return { ok: true, json: async () => ({ content: [{ text }] }) };
}

const ALL_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
  'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_MODEL', 'OLLAMA_HOST',
];

describe('callChat (provider-agnostic resolver)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, ''); // isolate from the host machine's env
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('ALIGN_LLM_BASE_URL escape hatch wins over named-provider keys and posts there', async () => {
    vi.stubEnv('ALIGN_LLM_BASE_URL', 'https://api.x.ai/v1');
    vi.stubEnv('ALIGN_LLM_API_KEY', 'xai-key');
    vi.stubEnv('ALIGN_LLM_MODEL', 'grok-2-latest');
    vi.stubEnv('ANTHROPIC_API_KEY', 'should-be-ignored');
    mockFetch.mockResolvedValue(openAiResponse('hatch answer'));

    const r = await callChat('sys', 'usr');

    expect(r).toBe('hatch answer');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('grok-2-latest');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer xai-key');
  });

  it('supports Grok (xAI) via GROK_API_KEY -> api.x.ai', async () => {
    vi.stubEnv('GROK_API_KEY', 'grok-k');
    mockFetch.mockResolvedValue(openAiResponse('grok answer'));

    const r = await callChat('s', 'u');

    expect(r).toBe('grok answer');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
  });

  it('prefers Anthropic over OpenAI when both keys are present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    vi.stubEnv('OPENAI_API_KEY', 'o');
    mockFetch.mockResolvedValue(anthropicResponse('anthropic answer'));

    const r = await callChat('s', 'u');

    expect(r).toBe('anthropic answer');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('returns null when no provider is configured and Ollama is unreachable', async () => {
    mockFetch.mockResolvedValue({ ok: false }); // ollama /api/tags not ok
    const r = await callChat('s', 'u');
    expect(r).toBeNull();
  });
});

describe('SYNTHESIS_SYSTEM_PROMPT carries the abstention contract (ollama-vet eval, 2026-08-25)', () => {
  // Measured: with no abstention instruction, ALL of llama3.2, deepseek-r1 and
  // WhiteRabbitNeo fabricated a database-sharding decision on 6 of 6 runs when
  // asked about something the context did not contain - and "authoritative"
  // in the prompt is what they were obeying. The instruction is pinned here
  // the way a render contract is (ALI-586): a prompt edit that drops the
  // abstention line must go red, because the eval that catches it costs three
  // model runs and this test costs milliseconds.
  it('tells the model to abstain with the EXACT sentinel sentence, and never to invent', () => {
    // The abstention is a mandated verbatim sentence, not a style suggestion: the ask
    // command detects it (isAbstention) to auto-widen a scoped search to the whole graph,
    // so the instruction, the sentinel constant and the detector must agree. Anchored to
    // the sentinel itself, not the bare words "does not answer" - the partial-answer
    // instruction below also contains those words, so an unanchored match would stay
    // green if someone deleted the abstention sentence itself.
    expect(SYNTHESIS_SYSTEM_PROMPT).toContain(`reply with exactly "${ABSTENTION_SENTINEL}"`);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/never (guess|invent)/i);
  });

  // Found live 2026-09-02, second pass: asked "why did align-cli stop using the nodejs
  // suffix?", with PR #231 correctly retrieved as top source, the model answered "The
  // context does not answer this question. While the decision explains that align-cli
  // stopped using the nodejs suffix... it does not state why - only that the suffix
  // caused a bug where config and graph state lived in different directories." The
  // denied "why" IS the clause it then delivers. The abstention rule is binary and the
  // model handled the partial-answer middle case by doing both halves at once - a
  // self-contradicting answer that reads worse than either a plain answer or a plain
  // abstention. There is deliberately NO deterministic strip for this (unlike the
  // em-dash): telling a self-contradiction from an honest "partially answers, here is
  // the part that is missing" is semantic, and a wrong trigger rewrites a good answer.
  it('tells the model a partial or implicit answer is still an answer', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/partial or implicit answer is still an answer/i);
  });

  it('names the deny-then-deliver shape as forbidden', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(
      /never say the context does not answer the question and then answer it anyway/i,
    );
  });
});

/**
 * The detector the ask command's auto-widen keys on: a scoped search whose synthesis
 * abstains is re-run over the whole graph (the cross-repo case found live 2026-09-02,
 * where the answer existed in align-cli's decisions while the question was asked from
 * align-stack). startsWith, not equality, on purpose: a model that abstains and then
 * keeps talking is the deny-then-deliver output, and widening is the correct recovery
 * for that too.
 */
describe('isAbstention', () => {
  it('detects the exact sentinel', () => {
    expect(isAbstention(ABSTENTION_SENTINEL)).toBe(true);
  });

  it('detects the sentinel with surrounding whitespace or trailing elaboration', () => {
    expect(isAbstention(`  ${ABSTENTION_SENTINEL}  `)).toBe(true);
    expect(isAbstention(`${ABSTENTION_SENTINEL} While the decision explains...`)).toBe(true);
  });

  it('does NOT flag a real answer that merely mentions unanswered ground', () => {
    expect(isAbstention('The suffix was removed because config and graph state diverged. The context does not answer when.')).toBe(false);
    // Positive control for the negative pair above: an empty string is not an abstention
    // either - absence of an answer is a failure, not an abstention.
    expect(isAbstention('')).toBe(false);
  });

  it('tells the model to surface contradictions rather than pick a winner', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT.toLowerCase()).toContain('conflict');
  });

  it('no longer says "authoritative" - the measured licence to confabulate', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT.toLowerCase()).not.toContain('authoritative');
    // Positive control for the negative assertion: the constant is real prose,
    // not an empty string a broken import would also satisfy.
    expect(SYNTHESIS_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  // Found live 2026-09-02: `align ask` synthesised an answer containing an em-dash
  // (mirroring the punctuation of the source Confluence content it was summarising) -
  // the same tell code-style.md bans in everything WE write, now showing up in
  // something the MODEL writes on our behalf. The prompt never said anything about
  // punctuation, so the model was free to copy the source's style.
  it('tells the model never to use an em-dash', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/never use an? em-?dash/i);
  });
});

// The prompt instruction above is the ask-nicely layer, and smaller local models
// (the ones David and Tom are actually testing with, via Ollama or a local
// llama.cpp endpoint) are not reliable about following style constraints. code-
// style.md treats "no em-dash" as a hard rule for everything WE write, not a
// preference to re-litigate - the model-generated surface a user actually reads
// deserves the same guarantee, not just a request the model can ignore.
describe('synthesiseDetailed strips em-dashes the model used anyway', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('replaces an em-dash the provider returned with the house style', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('Postgres was chosen—concurrent writers mattered.'));

    const result = await synthesiseDetailed('why postgres', []);

    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toBe('Postgres was chosen - concurrent writers mattered.');
  });

  // Positive control for the negative-shaped assertion above: text with no em-dash
  // must survive completely unchanged, or this could be a check that rewrites every
  // answer rather than one that only touches the character in question.
  it('leaves text with no em-dash untouched', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('Postgres was chosen for concurrent writers.'));

    const result = await synthesiseDetailed('why postgres', []);

    expect(result.ok && result.text).toBe('Postgres was chosen for concurrent writers.');
  });
});
