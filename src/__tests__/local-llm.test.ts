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
  synthesisSentenceBudget,
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

/**
 * ALI-894 test list (written first, driven one behavior at a time):
 *
 * 1. A single retrieved decision keeps the sentence budget at the original tight
 *    range - the regression net. Composition must not make a simple answer verbose.
 * 2. Two or more retrieved decisions widen the sentence budget past the flat cap that
 *    only fits a single-decision answer, so a composed answer is not squeezed into a
 *    size built for one decision. The budget is carried in buildUserPrompt's header
 *    (the user turn, which already knows decisions.length), not in the static system
 *    prompt - so the reserve-token calculation in buildUserPrompt stays self-consistent
 *    without SYNTHESIS_SYSTEM_PROMPT itself needing to vary per call.
 * 3. buildUserPrompt still states a sentence budget when there are no decisions at all
 *    (the early-return path), because SYNTHESIS_SYSTEM_PROMPT unconditionally tells the
 *    model to use "the sentence budget given with the question" - the empty-decisions
 *    path must not make that a promise the prompt sometimes breaks (Copilot review, PR #269).
 * 4. SYNTHESIS_SYSTEM_PROMPT tells the model composition across decisions is a correct
 *    answer, not a guess - and ties that permission to the SAME sentence that requires
 *    attributing each part to the decision it came from. This is the most important
 *    invariant here: composition without attribution is exactly the confabulation risk
 *    the abstention contract was added to prevent.
 * 5. SYNTHESIS_SYSTEM_PROMPT's abstention trigger now covers "no decision, even combined"
 *    - not "no ONE decision" - so composing across decisions is never read by the model
 *    as the license to invent a claim none of the retrieved decisions actually makes.
 *    The existing isAbstention / abstain-with-the-sentinel tests above are the regression
 *    net for the genuine "does not answer at all" case and stay green unchanged.
 */
describe('synthesisSentenceBudget scales with the number of retrieved decisions (ALI-894)', () => {
  it('keeps zero or one decision at the original tight budget - regression net', () => {
    expect(synthesisSentenceBudget(0)).toBe('2-4 concise sentences');
    expect(synthesisSentenceBudget(1)).toBe('2-4 concise sentences');
  });

  it('widens once composing across two decisions', () => {
    expect(synthesisSentenceBudget(2)).toBe('3-6 concise sentences');
  });

  it('widens further for three or more decisions - the live ALI-894 repro retrieved five', () => {
    expect(synthesisSentenceBudget(3)).toBe('4-8 concise sentences');
    expect(synthesisSentenceBudget(5)).toBe('4-8 concise sentences');
  });
});

describe('buildUserPrompt carries the sentence budget in its header, sized to decisions.length (ALI-894)', () => {
  it('embeds the tight single-decision budget for one decision', () => {
    const prompt = buildUserPrompt(
      'why postgres',
      [{ id: 'd1', title: 'Use Postgres', summary: 'Chosen for concurrent writers.' }],
      4096,
      SYNTHESIS_MAX_TOKENS,
    );
    expect(prompt).toContain(synthesisSentenceBudget(1));
  });

  it('embeds a wider budget for five decisions - the live ALI-894 repro shape', () => {
    const decisions = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, title: `Decision ${i}`, summary: 'S' }));
    const prompt = buildUserPrompt(
      'when did we stop blocking PRs on the gate, and why',
      decisions,
      4096,
      SYNTHESIS_MAX_TOKENS,
    );
    expect(prompt).toContain(synthesisSentenceBudget(5));
    expect(prompt).not.toContain(synthesisSentenceBudget(1));
  });

  // Copilot review (PR #269): SYNTHESIS_SYSTEM_PROMPT unconditionally tells the model to
  // use "the sentence budget given with the question" - so the empty-decisions path must
  // still give one, or the prompt promises something it does not always deliver.
  it('still states a sentence budget when there are no decisions, so the system prompt keeps its promise', () => {
    const prompt = buildUserPrompt('why postgres', [], 4096, SYNTHESIS_MAX_TOKENS);
    expect(prompt).toContain(synthesisSentenceBudget(0));
  });
});

describe('SYNTHESIS_SYSTEM_PROMPT permits composition across decisions without loosening abstention (ALI-894)', () => {
  // Reproduced live 2026-09-05 against align-stack: retrieval returned five genuinely
  // relevant decisions that together answered the question, and synthesis abstained
  // anyway - "no decision explicitly states... or gives a unified reason" - because the
  // prompt never said an answer could be assembled from more than one decision, and a
  // flat 2-4 sentence cap only fit a single-decision answer.
  it('tells the model composing across several decisions is a correct answer, not a guess', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/more than one decision/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/no single decision/i);
  });

  // The most important invariant here (ALI-894's own test list): composition and
  // attribution are tied together in the SAME instruction, so a model cannot read the
  // composition permission without also reading the attribution requirement it comes with.
  it('ties composition to attribution in the same instruction', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(
      /no single decision states it but the decisions together do, compose the answer from all of them, attributing each part to the decision it came from/i,
    );
  });

  // The abstention trigger must scope to the WHOLE context now that composition is
  // permitted, or "no single decision covers this" (composition working correctly) and
  // "no decision covers this" (genuine abstention) collapse into the same reading - the
  // exact defect this ticket fixes. "reply with exactly" stays anchored to the sentinel
  // itself, matching the existing verbatim-sentinel test above.
  it('scopes the abstention trigger to every decision combined, not any one decision read alone', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/even taking every decision together/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toContain(`reply with exactly "${ABSTENTION_SENTINEL}"`);
  });
});

// Integration: the widened budget must actually reach the model, not just exist as a
// pure function. `tryAnthropic` sends the user turn as messages[0].content and the
// static system prompt as the separate `system` field, so the sentence budget is only
// really wired up if it shows up in the CONTENT sent, scaled to what was retrieved.
describe('synthesiseDetailed sends a decision-count-scaled sentence budget to the model (ALI-894)', () => {
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

  it('sends the tight single-decision budget when exactly one decision is retrieved - regression net', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('an answer'));

    await synthesiseDetailed('why postgres', [
      { id: 'd1', title: 'Use Postgres', summary: 'Chosen for concurrent writers.' },
    ]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.messages[0].content).toContain(synthesisSentenceBudget(1));
  });

  // Shape 1: a when+why pair, neither decision alone naming both halves.
  it('widens the budget composing a when+why pair across two decisions', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('an answer'));
    const decisions = [
      { id: 'd1', title: 'Remove blocking align-gate check', summary: 'Removed the gate on 3 Sep.' },
      {
        id: 'd2',
        title: 'Root cause: gate severity bug',
        summary: 'The gate was failing docs-only PRs on a severity bug, now fixed.',
      },
    ];

    await synthesiseDetailed('when did we stop blocking PRs on the gate, and why', decisions);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.messages[0].content).toContain(synthesisSentenceBudget(2));
    expect(body.messages[0].content).not.toContain(synthesisSentenceBudget(1));
  });

  // Shape 2: a what+superseded-by pair, and the live repro's full retrieval size (five
  // decisions) at once.
  it('widens the budget further composing a what+superseded-by pair among five retrieved decisions', async () => {
    mockFetch.mockResolvedValue(anthropicResponse('an answer'));
    const decisions = [
      { id: 'd1', title: 'Use polling for job status', summary: 'Chose polling for simplicity.' },
      { id: 'd2', title: 'Migrate job status to webhooks', summary: 'Polling was too slow; superseded by webhooks.' },
      { id: 'd3', title: 'Gate severity bug', summary: 'Fixed a false positive that blocked docs-only PRs.' },
      { id: 'd4', title: 'Gate blocks with no remedy', summary: 'A complaint about the gate with no stated fix.' },
      { id: 'd5', title: 'Interactive command gating', summary: 'A related decision about gating interactive commands.' },
    ];

    await synthesiseDetailed('what did we use for job status, and what replaced it', decisions);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.messages[0].content).toContain(synthesisSentenceBudget(5));
  });
});
