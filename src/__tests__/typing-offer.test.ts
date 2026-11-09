import { describe, expect, it, vi } from 'vitest';
import { offerBackgroundTyping, type TypingOfferDeps, typingOfferQuestion } from '../lib/model-step.js';
import { BACKGROUND_CLASSIFY_MAX } from '../lib/sync/classify.js';

// The question at the end of setup: typing relationships spends the person's key, so it is asked
// once, at a terminal, with a model set up, and it says what it costs.
function deps(over: Partial<TypingOfferDeps> = {}) {
  const saved: boolean[] = [];
  const d: TypingOfferDeps = {
    hasProvider: () => true,
    providerLabel: () => 'Anthropic key',
    answered: () => false,
    confirm: vi.fn(async () => true),
    save: (on) => { saved.push(on); },
    log: { info: () => {} },
    ...over,
  };
  return { d, saved };
}

describe('the relationship-typing question at the end of setup', () => {
  it('names the provider and the per-refresh limit', () => {
    const q = typingOfferQuestion('Anthropic key');
    expect(q).toContain('Anthropic key');
    expect(q).toContain(`up to ${BACKGROUND_CLASSIFY_MAX} items`);
  });

  it.each([[true, 'on'], [false, 'off']] as const)('answer %s is saved, and returned as %s', async (answer, result) => {
    const { d, saved } = deps({ confirm: vi.fn(async () => answer) });
    expect(await offerBackgroundTyping({ interactive: true }, d)).toBe(result);
    expect(saved).toEqual([answer]);
  });

  it('Ctrl-C saves nothing, so the next setup asks again', async () => {
    const { d, saved } = deps({ confirm: vi.fn(async () => null) });
    expect(await offerBackgroundTyping({ interactive: true }, d)).toBe('not-asked');
    expect(saved).toEqual([]);
  });

  it.each([
    ['there is no terminal', { interactive: false }, {}],
    ['no model is set up', { interactive: true }, { hasProvider: () => false }],
    ['it was already answered', { interactive: true }, { answered: () => true }],
  ])('is not asked when %s', async (_n, opts, over) => {
    const confirm = vi.fn(async () => true);
    const { d, saved } = deps({ ...over, confirm });
    expect(await offerBackgroundTyping(opts, d)).toBe('not-asked');
    expect(confirm).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });
});
