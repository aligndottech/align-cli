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
