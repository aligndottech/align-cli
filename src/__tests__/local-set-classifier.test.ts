// P3 (shared detector): the v1 local classifier. One model call per check over every candidate,
// the shared prompt, and the `incompatible` verdict resolved deterministically. The provider is a
// fake at the call boundary (no network); the prompt, parser and resolver are real.
import { describe, expect, it, vi } from 'vitest';
import { classifyCandidateSet, type SetCandidate } from '../lib/local-set-classifier.js';
import type { ChatResult } from '../lib/local-llm.js';

const ev = { new_quote: 'cap the pool at 12', existing_quote: 'pool max is 40' };
const cands = (n: number): SetCandidate[] => Array.from({ length: n }, (_, i) => ({
  id: `d${i + 1}`, title: `Decision ${i + 1}`, summary: `Summary ${i + 1}.`, similarity: 0.8,
  platform: 'github', decidedAt: `2026-01-0${i + 1}T00:00:00Z`, status: null,
}));
const subject = { title: 'Cap the pool at 12', summary: 'Pool max 12.', decidedAt: null, platform: 'cli' };

function fake(answer: unknown) {
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  return vi.fn(async (_s: string, _u: string | ((w: number) => string), _o?: unknown): Promise<ChatResult> => ({ ok: true, text }));
}
const userOf = (call: ReturnType<typeof fake>): string => {
  const u = call.mock.calls[0]![1];
  return typeof u === 'function' ? u(200_000) : u;
};

describe('classifyCandidateSet: one call', () => {
  it('3 candidates -> ONE call whose user prompt lists all 3 with title, summary, decided_at and source', async () => {
    const call = fake({ relationships: { similar: [] } });
    await classifyCandidateSet(subject, cands(3), call);
    expect(call).toHaveBeenCalledTimes(1);
    const user = userOf(call);
    for (const i of [1, 2, 3]) {
      expect(user).toContain(`${i}. Decision ${i} (similarity: 0.80) [Platform: github] [decided 2026-01-0${i}]`);
      expect(user).toContain(`   Summary ${i}.`);
    }
  });

  it('1 candidate -> still one call, with max_tokens from the formula and temperature 0', async () => {
    const call = fake({ relationships: { similar: [] } });
    await classifyCandidateSet(subject, cands(1), call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toMatchObject({ maxTokens: 2048, temperature: 0 });
  });

  it('5 candidates -> max_tokens 2560', async () => {
    const call = fake({ relationships: { similar: [] } });
    await classifyCandidateSet(subject, cands(5), call);
    expect(call.mock.calls[0]![2]).toMatchObject({ maxTokens: 2560 });
  });

  it('no candidates -> no call', async () => {
    const call = fake({ relationships: { similar: [] } });
    const r = await classifyCandidateSet(subject, [], call);
    expect(call).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, verdicts: [] });
  });
});

describe('classifyCandidateSet: an over-long evidence quote', () => {
  it('the fastify verdict (16-word new quote, 0.95) still comes back conflicts_with', async () => {
    const r = await classifyCandidateSet(subject, cands(1), fake({ relationships: { similar: [
      { decision_ref: 1, type: 'incompatible', confidence: 0.95, evidence: {
        new_quote: 'errors with statusCode in 1xx-3xx range keep that status code instead of falling back to 500',
        existing_quote: 'clamp error statusCode between 400 and 599 with 500 fallback',
      }, replaced: 'new', reasons: ['x'] },
    ] } }));
    expect(r).toMatchObject({ ok: true, verdicts: [{ relation: 'conflicts_with', confidence: 0.95 }] });
  });

  it('a 40-word quote on the existing side also survives', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const r = await classifyCandidateSet(subject, cands(1), fake({ relationships: { similar: [
      { decision_ref: 1, type: 'incompatible', confidence: 0.9, evidence: { new_quote: 'cap the pool at 12', existing_quote: long }, replaced: 'new', reasons: ['x'] },
    ] } }));
    expect(r).toMatchObject({ ok: true, verdicts: [{ relation: 'conflicts_with' }] });
  });

  it('a blank quote still discards the verdict', async () => {
    const r = await classifyCandidateSet(subject, cands(1), fake({ relationships: { similar: [
      { decision_ref: 1, type: 'incompatible', confidence: 0.9, evidence: { new_quote: ' ', existing_quote: 'pool max is 40' }, replaced: 'new', reasons: ['x'] },
    ] } }));
    expect(r).toMatchObject({ ok: true, verdicts: [{ relation: null }] });
  });
});

describe('classifyCandidateSet: verdicts', () => {
  it('incompatible becomes conflicts_with through the resolver (proposed change has no date)', async () => {
    const r = await classifyCandidateSet(subject, cands(2), fake({ relationships: { similar: [
      { decision_ref: 2, type: 'incompatible', confidence: 0.9, reasons: ['x'], evidence: ev, replaced: 'new' },
    ] } }));
    expect(r.ok && r.verdicts.map((v) => v.relation)).toEqual([null, 'conflicts_with']);
  });

  it('incompatible, new decision 3 days later and replacing -> supersedes', async () => {
    const r = await classifyCandidateSet({ ...subject, decidedAt: '2026-01-05T00:00:00Z' }, cands(1), fake({ similar: [
      { decision_ref: 1, type: 'incompatible', confidence: 0.7, evidence: ev, replaced: 'new' },
    ] }));
    expect(r.ok && r.verdicts[0]).toMatchObject({ relation: 'supersedes', confidence: 0.7 });
  });

  it('a model answering supersedes directly is refused (no edge), not written', async () => {
    const r = await classifyCandidateSet(subject, cands(2), fake({ similar: [
      { decision_ref: 1, type: 'supersedes', confidence: 0.9 },
      { decision_ref: 2, type: 'conflicts_with', confidence: 0.9 },
    ] }));
    expect(r.ok && r.verdicts.map((v) => v.relation)).toEqual([null, null]);
  });

  it('an omitted candidate gets no relation; a candidate typed relates is relates', async () => {
    const r = await classifyCandidateSet(subject, cands(3), fake({ similar: [{ decision_ref: 3, type: 'relates', confidence: 0.6 }] }));
    expect(r.ok && r.verdicts.map((v) => v.relation)).toEqual([null, null, 'relates']);
    expect(r.ok && r.verdicts[2]!.confidence).toBe(0.6);
  });

  it('incompatible without evidence is dropped (contract), not resolved', async () => {
    const r = await classifyCandidateSet(subject, cands(1), fake({ similar: [{ decision_ref: 1, type: 'incompatible', confidence: 0.9 }] }));
    expect(r.ok && r.verdicts[0]!.relation).toBeNull();
  });

  it('a decision_ref outside the list is ignored; a repeated ref keeps the first entry', async () => {
    const r = await classifyCandidateSet(subject, cands(2), fake({ similar: [
      { decision_ref: 7, type: 'relates' },
      { decision_ref: 0, type: 'relates' },
      { decision_ref: '1', type: 'refines', confidence: 0.4 },
      { decision_ref: 1, type: 'duplicates', confidence: 0.9 },
    ] }));
    expect(r.ok && r.verdicts.map((v) => v.relation)).toEqual(['refines', null]);
  });

  it('a retired candidate never gets a verdict edge', async () => {
    const list = cands(1).map((c) => ({ ...c, status: 'superseded' }));
    const r = await classifyCandidateSet(subject, list, fake({ similar: [{ decision_ref: 1, type: 'incompatible', confidence: 0.9, evidence: ev }] }));
    expect(r.ok && r.verdicts[0]!.relation).toBeNull();
  });

  it('reasons[] from the shared schema become the verdict reason; an explicit reason wins', async () => {
    const r = await classifyCandidateSet(subject, cands(2), fake({ similar: [
      { decision_ref: 1, type: 'relates', reasons: ['same queue', 'same team'] },
      { decision_ref: 2, type: 'relates', reason: 'own', reasons: ['ignored'] },
    ] }));
    expect(r.ok && r.verdicts.map((v) => v.reason)).toEqual(['same queue; same team', 'own']);
  });

  it('the answer may be wrapped in prose and a code fence', async () => {
    const r = await classifyCandidateSet(subject, cands(1), fake('Sure:\n```json\n{"similar":[{"decision_ref":1,"type":"supports","confidence":0.5}]}\n```'));
    expect(r.ok && r.verdicts[0]!.relation).toBe('supports');
  });
});

describe('classifyCandidateSet: failures', () => {
  it('no JSON at all -> classifier_unparseable for the whole set', async () => {
    expect(await classifyCandidateSet(subject, cands(2), fake('I cannot help with that.'))).toEqual({ ok: false, reason: 'classifier_unparseable' });
  });

  it('JSON without a similar array -> classifier_unparseable', async () => {
    expect(await classifyCandidateSet(subject, cands(2), fake({ relationships: { existing: {} } }))).toEqual({ ok: false, reason: 'classifier_unparseable' });
  });

  it('a stopped provider -> classifier_error carrying the failure', async () => {
    const failure = { kind: 'provider_stopped' as const, provider: 'anthropic', model: 'm', detail: '429' };
    const call = vi.fn(async (): Promise<ChatResult> => ({ ok: false, failure }));
    expect(await classifyCandidateSet(subject, cands(2), call)).toEqual({ ok: false, reason: 'classifier_error', failure });
  });

  it('unvetted local models -> unvetted_local_model', async () => {
    const failure = { kind: 'unrecognised_local_models' as const, models: ['x'] };
    const call = vi.fn(async (): Promise<ChatResult> => ({ ok: false, failure }));
    expect(await classifyCandidateSet(subject, cands(1), call)).toMatchObject({ ok: false, reason: 'unvetted_local_model' });
  });
});
