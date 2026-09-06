import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_RELATIONSHIPS, isDecisionRelationship } from '@aligndottech/connector-core';
import { buildUserPrompt, classifyRelationship, RELATIONSHIP_TYPES } from '../lib/local-relationship-classifier.js';
import { CLASSIFIER_MAX_TOKENS } from '../lib/local-llm.js';
import { estimateTokens } from '../lib/token-estimate.js';

const A = { title: 'Standardise on MySQL', summary: 'We chose MySQL as the primary database.' };
const B = { title: 'Migrate to Postgres', summary: 'Switch the service database to Postgres.' };

const mockFetch = vi.fn();

function anthropicResponse(json: unknown) {
  return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(json) }] }) };
}

describe('classifyRelationship', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ALIGN_CLASSIFIER_MAX_TOKENS', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ALI-414: the three ways classification can fail used to collapse into a single
  // `null`, so the caller could not tell "no key configured" from "the model replied
  // with garbage" - and reported both as `aligned`. Each now reports its own reason.
  it('reports no_llm_key when no cloud key and no local Ollama', async () => {
    // No cloud provider keys (beforeEach) + Ollama unreachable. The shared resolver
    // probes local Ollama as a last resort, so it fails only when that is also gone.
    mockFetch.mockResolvedValue({ ok: false }); // Ollama /api/tags not ok
    const result = await classifyRelationship(A, B);
    expect(result).toEqual({ ok: false, reason: 'no_llm_key', failure: { kind: 'no_provider' } });
  });

  // ALI-420: an unvetted local model must not assert typed edges. These are written into
  // the local graph and sync to the org graph, so a wrong `conflicts_with` here is a data
  // write, not a rendering the user can judge.
  it('reports unvetted_local_model when Ollama is running with no vetted model', async () => {
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
      'GROK_API_KEY', 'XAI_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_OLLAMA_MODEL']) {
      vi.stubEnv(k, '');
    }
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M' }] }) }
        : { ok: false });

    const result = await classifyRelationship(A, B);

    // NOT no_llm_key: that hint tells the user to "run a local Ollama", and they are.
    expect(result).toEqual({
      ok: false,
      reason: 'unvetted_local_model',
      // The models travel on the value, so a presenter can name them for THIS candidate.
      failure: { kind: 'unrecognised_local_models', models: ['WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M'] },
    });
  });

  it('types the relationship via Anthropic when ANTHROPIC_API_KEY is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce(anthropicResponse({ type: 'supersedes', confidence: 0.88, reason: 'B replaces A' }));
    const result = await classifyRelationship(A, B);
    expect(mockFetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.anything());
    expect(result).toEqual({ ok: true, relationship: { type: 'supersedes', confidence: 0.88, reason: 'B replaces A' } });
  });

  it('reports classifier_unparseable for malformed LLM output', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ text: 'not json at all' }] }) });
    const result = await classifyRelationship(A, B);
    expect(result).toEqual({ ok: false, reason: 'classifier_unparseable' });
  });

  it('rejects a relationship type outside the taxonomy', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce(anthropicResponse({ type: 'is_friends_with', confidence: 0.9 }));
    const result = await classifyRelationship(A, B);
    expect(result).toEqual({ ok: false, reason: 'classifier_unparseable' });
  });

  // The distinction that matters: a configured provider that FAILED is a different
  // state from no provider at all, and only the first is worth retrying.
  it('reports classifier_error when a configured provider call fails', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const result = await classifyRelationship(A, B);
    expect(result).toMatchObject({ ok: false, reason: 'classifier_error' });
    // Not just the reason: the model that failed rides along, which is what lets
    // `align check` name it instead of printing an empty remedy.
    expect(result).toMatchObject({ failure: { kind: 'provider_stopped' } });
  });

  // ALI-692: an Ollama model that ANSWERED, unusably, used to fall into no_llm_key
  // because hasConfiguredProvider() is env-only and cannot see local Ollama. That hint
  // tells this user to configure a provider - they have one, and it replied.
  it('reports classifier_error, not no_llm_key, when local Ollama answered unusably with no keys set', async () => {
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
      'GROK_API_KEY', 'XAI_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_OLLAMA_MODEL']) {
      vi.stubEnv(k, '');
    }
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) }
        : { ok: true, json: async () => ({ message: { content: '' } }) });

    const result = await classifyRelationship(A, B);

    expect(result).toMatchObject({ ok: false, reason: 'classifier_error' });
    // Not just the reason: the model that failed rides along, which is what lets
    // `align check` name it instead of printing an empty remedy.
    expect(result).toMatchObject({ failure: { kind: 'provider_stopped' } });
  });

  it('uses the canonical connector-core vocabulary, not an invented local list', () => {
    // ALI-219: the local classifier previously invented types (implements,
    // depends_on, relates_to) that the graph never accepts. It must now be the
    // canonical DecisionRelationship set - one source of truth with the gateway.
    expect(RELATIONSHIP_TYPES).toEqual(DECISION_RELATIONSHIPS);
  });

  it('emits only types the decision graph accepts (anti-drift)', () => {
    // Every type the classifier can emit must be a canonical relationship, or a
    // local edge would be rejected by the graph on personal->org sync.
    for (const t of RELATIONSHIP_TYPES) {
      expect(isDecisionRelationship(t)).toBe(true);
    }
  });

  it('rejects a non-canonical type from the LLM (e.g. the old depends_on)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce(anthropicResponse({ type: 'depends_on', confidence: 0.9 }));
    const result = await classifyRelationship(A, B);
    expect(result).toEqual({ ok: false, reason: 'classifier_unparseable' });
  });

  it('classifies at temperature 0 so the same pair types the same way each run', () => {
    // ALI-218: local relationship typing must be deterministic - offline scans
    // otherwise produce different conflicts/supersessions each run. The request
    // to the provider must pin temperature 0 (it previously omitted it, defaulting
    // to the provider's ~1.0).
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce(anthropicResponse({ type: 'supersedes', confidence: 0.9 }));
    return classifyRelationship(A, B).then(() => {
      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as { body: string }).body);
      expect(body.temperature).toBe(0);
    });
  });

  // ALI-845 defect 2: the classifier's whole output is a ~60-char JSON object, distinct
  // from synthesis's own >=1,024 budget (local-llm.test.ts). Own describe below because
  // this assertion is satisfiable by the UNCHANGED adapter default (256) too - see the
  // manufactured-RED note there for why that is not evidence on its own.
  it('sends 256 as max_tokens - the classifier\'s own budget, not a shared default', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce(anthropicResponse({ type: 'supersedes', confidence: 0.9 }));

    await classifyRelationship(A, B);

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body);
    expect(body.max_tokens).toBe(256);
  });
});

// ALI-845 defect 3 (classifier side): buildUserPrompt cut neither side. Both decisions get
// an equal share of the same budget the synthesis prompt uses (local-llm.test.ts).
describe('buildUserPrompt caps each side to its share of the window', () => {
  it('cuts an oversized Decision B while leaving A present and non-empty', () => {
    // Cutting the wrong side, or cutting both to nothing, both pass a length-only
    // assertion - so this checks A is untouched AND B was actually reduced.
    const bigB = { title: 'Migrate to Postgres', summary: 'x'.repeat(60_000) };
    const prompt = buildUserPrompt(A, bigB, 4096, CLASSIFIER_MAX_TOKENS);

    expect(prompt).toContain(A.summary);
    expect(prompt).toContain(`Decision A: ${A.title}`);
    expect(prompt).not.toContain(bigB.summary);
    const bMatch = prompt.match(/Decision B: .*?\. (.*)$/s);
    expect(bMatch?.[1]?.length ?? 0).toBeGreaterThan(0);
    expect(bMatch?.[1]?.length ?? 0).toBeLessThan(60_000);
  });

  it('leaves both sides untouched when they already fit', () => {
    const prompt = buildUserPrompt(A, B, 4096, CLASSIFIER_MAX_TOKENS);
    expect(prompt).toBe(`Decision A: ${A.title}. ${A.summary}\n\nDecision B: ${B.title}. ${B.summary}`);
  });

  // Copilot review (PR #258): the reserve accounted for the system prompt and the output
  // budget, but not the "Decision A: <title>. " / "Decision B: <title>. " label overhead
  // wrapped around each side. A long title alone can then push the prompt over the window
  // even though both summaries were correctly cut to their share.
  it('reserves budget for the "Decision A/B: title. " label overhead, so long titles cannot blow the window', () => {
    const windowTokens = 4096;
    const outputTokens = CLASSIFIER_MAX_TOKENS;
    const longTitle = 'X'.repeat(1000);
    const bigSummary = 'y'.repeat(100_000);
    const a = { title: longTitle, summary: bigSummary };
    const b = { title: longTitle, summary: bigSummary };

    const prompt = buildUserPrompt(a, b, windowTokens, outputTokens);

    expect(estimateTokens(prompt) + outputTokens).toBeLessThanOrEqual(windowTokens);
  });
});
