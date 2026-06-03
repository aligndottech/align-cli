import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyRelationship, RELATIONSHIP_TYPES } from '../lib/local-relationship-classifier.js';

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

  it('returns null when no cloud key and no local Ollama (degrade to untyped)', async () => {
    // No cloud provider keys (beforeEach) + Ollama unreachable. The shared resolver
    // now probes local Ollama as a last resort, so it degrades to null only when
    // that is also unavailable.
    mockFetch.mockResolvedValue({ ok: false }); // Ollama /api/tags not ok
    const result = await classifyRelationship(A, B);
    expect(result).toBeNull();
  });

  it('types the relationship via Anthropic when ANTHROPIC_API_KEY is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce(anthropicResponse({ type: 'supersedes', confidence: 0.88, reason: 'B replaces A' }));
    const result = await classifyRelationship(A, B);
    expect(mockFetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.anything());
    expect(result).toEqual({ type: 'supersedes', confidence: 0.88, reason: 'B replaces A' });
  });

  it('returns null for malformed LLM output (safe degrade)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ text: 'not json at all' }] }) });
    const result = await classifyRelationship(A, B);
    expect(result).toBeNull();
  });

  it('rejects a relationship type outside the taxonomy', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce(anthropicResponse({ type: 'is_friends_with', confidence: 0.9 }));
    const result = await classifyRelationship(A, B);
    expect(result).toBeNull();
  });

  it('returns null when the API call fails', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    const result = await classifyRelationship(A, B);
    expect(result).toBeNull();
  });

  it('exposes the cloud taxonomy', () => {
    expect(RELATIONSHIP_TYPES).toContain('conflicts_with');
    expect(RELATIONSHIP_TYPES).toContain('supersedes');
    expect(RELATIONSHIP_TYPES).toContain('relates_to');
  });
});
