import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_RELATIONSHIPS, isDecisionRelationship } from '@aligndottech/connector-core';
import { classifyRelationship, RELATIONSHIP_TYPES } from '../lib/local-relationship-classifier.js';
import { resetLlmDiagnostics } from '../lib/local-llm.js';

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
    expect(result).toEqual({ ok: false, reason: 'no_llm_key' });
  });

  // ALI-420: an unvetted local model must not assert typed edges. These are written into
  // the local graph and sync to the org graph, so a wrong `conflicts_with` here is a data
  // write, not a rendering the user can judge.
  it('reports unvetted_local_model when Ollama is running with no vetted model', async () => {
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
      'GROK_API_KEY', 'XAI_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_OLLAMA_MODEL']) {
      vi.stubEnv(k, '');
    }
    resetLlmDiagnostics();
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M' }] }) }
        : { ok: false });

    const result = await classifyRelationship(A, B);

    // NOT no_llm_key: that hint tells the user to "run a local Ollama", and they are.
    expect(result).toEqual({ ok: false, reason: 'unvetted_local_model' });
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
    expect(result).toEqual({ ok: false, reason: 'classifier_error' });
  });

  // ALI-692: an Ollama model that ANSWERED, unusably, used to fall into no_llm_key
  // because hasConfiguredProvider() is env-only and cannot see local Ollama. That hint
  // tells this user to configure a provider - they have one, and it replied.
  it('reports classifier_error, not no_llm_key, when local Ollama answered unusably with no keys set', async () => {
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
      'GROK_API_KEY', 'XAI_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_OLLAMA_MODEL']) {
      vi.stubEnv(k, '');
    }
    resetLlmDiagnostics();
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) }
        : { ok: true, json: async () => ({ message: { content: '' } }) });

    const result = await classifyRelationship(A, B);

    expect(result).toEqual({ ok: false, reason: 'classifier_error' });
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
});
