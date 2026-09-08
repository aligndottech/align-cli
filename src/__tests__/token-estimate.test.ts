import { describe, expect, it } from 'vitest';
import { charsForTokens, estimateTokens } from '../lib/token-estimate.js';

describe('estimateTokens', () => {
  it('estimates at 2.56 chars/token with a 10% margin, not chars/4', () => {
    // 2,560 chars / 2.56 = 1,000 tokens; x1.1 margin = 1,100. chars/4 would give 640,
    // which is the defect this pins: chars/4 under-counts our corpus by ~36%, silently.
    expect(estimateTokens('x'.repeat(2560))).toBe(1100);
  });

  // Second example for the same rule, at a different size, so the ratio itself is pinned
  // rather than one lucky round number.
  it('scales linearly with length', () => {
    expect(estimateTokens('x'.repeat(1280))).toBe(550);
  });
});

describe('estimateTokens(charsForTokens(n)) <= n', () => {
  // The round-trip invariant that stops the two functions drifting into two writers of
  // one ratio: charsForTokens rounds DOWN and estimateTokens rounds UP, so composing them
  // must never overshoot the token count you started from.
  it.each([1, 100, 4096, 200_000])('holds for n=%d', (n) => {
    expect(estimateTokens('x'.repeat(charsForTokens(n)))).toBeLessThanOrEqual(n);
  });
});

// ALI-852 rule 9: estimateTokens/charsForTokens are per family and never under-count.
describe('per-family ratio (ALI-852)', () => {
  it('uses 4.0 chars/token for gpt-4o-mini and 3.43 for claude-haiku-4-5 - two different numbers from one input', () => {
    const text = 'x'.repeat(1000);
    // 1000 / 4.0 * 1.1 = 275
    expect(estimateTokens(text, 'gpt-4o-mini')).toBe(275);
    // 1000 / 3.43 * 1.1 = 320.6... -> ceil 321
    expect(estimateTokens(text, 'claude-haiku-4-5')).toBe(321);
  });

  it('longest-prefix matches a dated model id, e.g. claude-haiku-4-5-20251001', () => {
    const text = 'x'.repeat(1000);
    expect(estimateTokens(text, 'claude-haiku-4-5-20251001')).toBe(estimateTokens(text, 'claude-haiku-4-5'));
  });

  it('falls back to the table minimum (2.56, today\'s value) for an unknown model - no existing call site moves', () => {
    const text = 'x'.repeat(2560);
    expect(estimateTokens(text, 'some-future-model-nobody-has-measured')).toBe(estimateTokens(text));
    expect(estimateTokens(text)).toBe(1100);
  });

  it('with no model argument at all, behaves exactly as before (today\'s 2.56-based value)', () => {
    expect(estimateTokens('x'.repeat(2560))).toBe(1100);
    expect(charsForTokens(1100)).toBe(charsForTokens(1100, undefined));
  });
});
