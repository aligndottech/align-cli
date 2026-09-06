import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ABSTENTION_SENTINEL,
  buildUserPrompt,
  callChat,
  callChatDetailed,
  HOSTED_WINDOW_TOKENS_DEFAULT,
  isAbstention,
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_SYSTEM_PROMPT,
  synthesiseDetailed,
} from '../lib/local-llm.js';
import { estimateTokens } from '../lib/token-estimate.js';

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
  'ALIGN_SYNTHESIS_MAX_TOKENS', 'ALIGN_CLASSIFIER_MAX_TOKENS', 'OLLAMA_CONTEXT_LENGTH',
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

// Copilot review (PR #258): `hostedUser` used to be computed eagerly at the top of
// callChatDetailed, so a callback-form prompt builder ran even when no hosted provider was
// ever attempted - here, Ollama-only, where the real prompt is the one built against
// Ollama's OWN resolved window (tryOllama calls `user` itself, further down).
describe('callChatDetailed evaluates a callback prompt builder lazily, only for a provider that runs it', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('never builds the hosted-placeholder prompt when only Ollama is configured', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) };
      }
      if (String(url).includes('/api/show')) {
        return { ok: true, json: async () => ({ model_info: { 'llama.context_length': 131_072 } }) };
      }
      return { ok: true, json: async () => ({ message: { content: 'an answer' } }) };
    });

    const user = vi.fn((windowTokens: number) => `prompt for ${windowTokens}`);
    const result = await callChatDetailed('sys', user);

    expect(result.ok).toBe(true);
    // Built exactly once, against Ollama's real resolved window - never against
    // HOSTED_WINDOW_TOKENS_DEFAULT, since no hosted adapter ever ran.
    expect(user).toHaveBeenCalledTimes(1);
    expect(user).toHaveBeenCalledWith(131_072);
    expect(user).not.toHaveBeenCalledWith(HOSTED_WINDOW_TOKENS_DEFAULT);
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

  it('asks for plain prose with no markdown, since the answer lands in a terminal', () => {
    // The ask-nicely layer; renderAnswer at the print site is the guarantee.
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/no markdown/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/asterisk/i);
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

// ALI-845 defect 2: the classifier's whole output is a ~60-char JSON object; `align ask`
// synthesis is 2-4 prose sentences. Sharing one 256-token ceiling visibly truncates the
// second, so each caller now has its own budget.
describe('synthesis has its own output budget, separate from the classifier', () => {
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

  it('sends at least 1,024 max_tokens by default - not the classifier\'s 256', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('an answer'));

    await synthesiseDetailed('why postgres', []);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
  });

  it('ALIGN_SYNTHESIS_MAX_TOKENS overrides the default, and an unusable value warns and falls back', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(anthropicResponse('an answer'));

    vi.stubEnv('ALIGN_SYNTHESIS_MAX_TOKENS', '4096');
    await synthesiseDetailed('why postgres', []);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string).max_tokens).toBe(4096);

    mockFetch.mockClear();
    errorSpy.mockClear();
    vi.stubEnv('ALIGN_SYNTHESIS_MAX_TOKENS', 'nonsense');
    await synthesiseDetailed('why postgres', []);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string).max_tokens).toBe(SYNTHESIS_MAX_TOKENS);
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('ALIGN_SYNTHESIS_MAX_TOKENS'))).toBe(true);

    errorSpy.mockRestore();
  });

  // The mirror-image half of defect 2 (ALI-845 defect 1's pairing): every hosted adapter
  // already caps output, and Ollama capped nothing. A hosted-only test cannot pin this -
  // it is the assertion that only an Ollama call can make.
  it('an Ollama synthesis call sends the synthesis budget as num_predict', async () => {
    for (const k of ALL_KEYS) vi.stubEnv(k, '');
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) };
      }
      return { ok: true, json: async () => ({ message: { content: 'synthesised answer' } }) };
    });

    await synthesiseDetailed('why postgres', []);

    const chatCall = mockFetch.mock.calls.find(c => String(c[0]).includes('/api/chat'))!;
    const body = JSON.parse(chatCall[1].body as string);
    expect(body.options.num_predict).toBe(SYNTHESIS_MAX_TOKENS);
  });
});

// ALI-845 defect 3: `buildUserPrompt` joined raw summaries with no cap of any kind. Every
// per-decision slice is now derived from the window budget, never an unconditional slice.
describe('buildUserPrompt caps each summary to its share of the window', () => {
  const decisionsOf = (count: number, summaryLength: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `d${i}`,
      title: `Decision ${i}`,
      summary: 'x'.repeat(summaryLength),
    }));

  it('cuts every summary so the whole prompt fits a 4,096-token window', () => {
    const decisions = decisionsOf(8, 5000);
    const prompt = buildUserPrompt('why?', decisions, 4096, SYNTHESIS_MAX_TOKENS);

    for (const d of decisions) {
      expect(prompt).not.toContain(d.summary); // the full 5,000-char summary never appears
    }
    expect(estimateTokens(prompt)).toBeLessThan(4096);
  });

  // Positive control for the rule above: a summary that already fits its share must NOT be
  // cut - an inequality, not an unconditional slice.
  it('leaves every summary untouched when it already fits', () => {
    const decisions = decisionsOf(8, 300);
    const prompt = buildUserPrompt('why?', decisions, 4096, SYNTHESIS_MAX_TOKENS);

    for (const d of decisions) {
      expect(prompt).toContain(`- ${d.title}: ${d.summary}`);
    }
  });

  // Copilot review (PR #258): the per-decision budget reserved the system prompt, header
  // and output tokens, but not the "- " + title + ": " label wrapped around every summary.
  // Enough decisions with long titles make that unreserved overhead alone exceed the window,
  // even though every summary was correctly cut to its share.
  it('reserves budget for the "- title: " label overhead, so long titles cannot blow the window', () => {
    const windowTokens = 4096;
    const outputTokens = SYNTHESIS_MAX_TOKENS;
    const decisions = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      title: 'X'.repeat(150),
      summary: 'y'.repeat(100_000),
    }));

    const prompt = buildUserPrompt('why?', decisions, windowTokens, outputTokens);

    expect(estimateTokens(prompt) + outputTokens).toBeLessThanOrEqual(windowTokens);
  });
});
