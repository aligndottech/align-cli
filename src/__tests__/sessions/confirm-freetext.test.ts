/**
 * ALI-809 Pass B, LLM half: the heuristic (extract-freetext.ts) proposes; only this
 * confirmation may assert. Mirrors local-relationship-classifier.ts's shape exactly (a system
 * prompt, callChatDetailed, a JSON-brace parse, a ClassifierFailureReason-shaped outcome) - not
 * a new pattern, the same one applied to a different candidate type (align decision ALI-409:
 * "heuristic proposes, LLM adjudicates, only adjudicated results assert").
 *
 * Test List:
 * 1. the model confirms a real decision: ok:true, decision set, title/confidence from the model
 * 2. the model says the heuristic misfired (not actually a decision): ok:true, decision: null
 * 3. no LLM configured: ok:false, reason 'no_llm_key'
 * 4. the model replies with unparseable text: ok:false, reason 'confirm_unparseable'
 * 5. the raw candidate's own humanText and contextText both reach the prompt sent to the model
 * 6. the confirmed decision's humanText is the candidate's verbatim text, not the model's title
 *    (ALI-538 principle: the model's title is a label for review, never a replacement for the
 *    human's own words)
 *
 * describeConfirmFailure (per-reason messaging, not one collapsed "no LLM configured" line -
 * the same mistake ALI-420 already fixed once for the sibling relationship classifier):
 * 7. no_llm_key names setting a cloud key or running Ollama
 * 8. unvetted_local_model names `ollama pull` and ALIGN_OLLAMA_MODEL, never "no LLM configured"
 * 9. confirm_error with a provider_stopped failure names the provider, model and detail
 * 10. confirm_error with no failure detail gives a generic retry hint, never "no LLM configured"
 * 11. confirm_unparseable says the model replied without usable JSON
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LocalLlmModule from '../../lib/local-llm.js';

const callChatDetailed = vi.hoisted(() => vi.fn());
const hasConfiguredProvider = vi.hoisted(() => vi.fn().mockReturnValue(true));
vi.mock('../../lib/local-llm.js', async (importOriginal) => {
  const original = await importOriginal<typeof LocalLlmModule>();
  return { ...original, callChatDetailed, hasConfiguredProvider };
});

import { confirmFreeTextCandidate, describeConfirmFailure } from '../../lib/sessions/confirm-freetext.js';
import type { RawFreeTextCandidate } from '../../lib/sessions/extract-freetext.js';

const CANDIDATE: RawFreeTextCandidate = {
  agent: 'codex', sessionId: 's1', messageId: 'turn-0',
  humanText: 'We\'re deciding the retry count for failed webhook deliveries.',
  contextText: 'Decision: 3 retries - enough to cover transient failures.',
  timestamp: '2026-09-03T13:47:42.000Z',
};

beforeEach(() => {
  callChatDetailed.mockReset();
  hasConfiguredProvider.mockReset().mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('confirmFreeTextCandidate', () => {
  it('confirms a real decision with a title and confidence from the model', async () => {
    callChatDetailed.mockResolvedValue({ ok: true, text: '{"isDecision": true, "title": "Retry count set to 3", "confidence": 0.9}' });
    const outcome = await confirmFreeTextCandidate(CANDIDATE);
    expect(outcome).toMatchObject({
      ok: true,
      decision: { agent: 'codex', sessionId: 's1', messageId: 'turn-0', title: 'Retry count set to 3', confidence: 0.9 },
    });
  });

  it('drops the candidate when the model says the heuristic misfired', async () => {
    callChatDetailed.mockResolvedValue({ ok: true, text: '{"isDecision": false, "title": "", "confidence": 0}' });
    const outcome = await confirmFreeTextCandidate(CANDIDATE);
    expect(outcome).toEqual({ ok: true, decision: null });
  });

  it('reports no_llm_key when nothing is configured', async () => {
    hasConfiguredProvider.mockReturnValue(false);
    callChatDetailed.mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } });
    const outcome = await confirmFreeTextCandidate(CANDIDATE);
    expect(outcome).toMatchObject({ ok: false, reason: 'no_llm_key' });
  });

  it('reports confirm_unparseable when the model reply has no usable JSON', async () => {
    callChatDetailed.mockResolvedValue({ ok: true, text: 'sure, sounds right' });
    const outcome = await confirmFreeTextCandidate(CANDIDATE);
    expect(outcome).toEqual({ ok: false, reason: 'confirm_unparseable' });
  });

  it('sends both the humanText and the contextText to the model', async () => {
    callChatDetailed.mockResolvedValue({ ok: true, text: '{"isDecision": true, "title": "t", "confidence": 0.5}' });
    await confirmFreeTextCandidate(CANDIDATE);
    const userArg = callChatDetailed.mock.calls[0][1] as string;
    expect(userArg).toContain(CANDIDATE.humanText);
    expect(userArg).toContain(CANDIDATE.contextText);
  });

  it('the confirmed decision carries the candidate\'s verbatim humanText, never the model\'s title in its place', async () => {
    callChatDetailed.mockResolvedValue({ ok: true, text: '{"isDecision": true, "title": "A short label", "confidence": 0.8}' });
    const outcome = await confirmFreeTextCandidate(CANDIDATE);
    expect(outcome.ok && outcome.decision?.humanText).toBe(CANDIDATE.humanText);
  });
});

describe('describeConfirmFailure: per-reason messaging', () => {
  it('no_llm_key names a cloud key or Ollama', () => {
    expect(describeConfirmFailure('no_llm_key')).toMatch(/cloud key|ollama/i);
  });

  it('unvetted_local_model names `ollama pull` and ALIGN_OLLAMA_MODEL, never "no LLM configured"', () => {
    const msg = describeConfirmFailure('unvetted_local_model');
    expect(msg).toMatch(/ollama pull/i);
    expect(msg).toMatch(/ALIGN_OLLAMA_MODEL/);
    expect(msg).not.toMatch(/no llm configured/i);
  });

  it('confirm_error with a provider_stopped failure names the provider, model and detail', () => {
    const msg = describeConfirmFailure('confirm_error', {
      kind: 'provider_stopped', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', detail: 'HTTP 429',
    });
    expect(msg).toContain('anthropic');
    expect(msg).toContain('claude-haiku-4-5-20251001');
    expect(msg).toContain('HTTP 429');
  });

  it('confirm_error with no failure detail gives a generic retry hint, not "no LLM configured"', () => {
    const msg = describeConfirmFailure('confirm_error');
    expect(msg).not.toMatch(/no llm configured/i);
  });

  it('confirm_unparseable says the model replied without usable JSON', () => {
    expect(describeConfirmFailure('confirm_unparseable')).toMatch(/json/i);
  });
});
