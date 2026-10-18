import { describe, expect, it } from 'vitest';
import { allWeak, excerptOf, isWeak, WEAK_MATCH_BELOW, withoutTitle } from '../lib/ask-listing.js';

describe('excerptOf', () => {
  const body40 = Array.from({ length: 40 }, (_, i) => `line${i} alpha beta gamma`).join('\n');

  it('cuts a 40-line body at a word boundary with an ellipsis', () => {
    const out = excerptOf(body40, 100);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(103);
    expect(out).not.toContain('\n');
    // every word before the ellipsis is a whole word from the body
    const words = new Set(body40.split(/\s+/));
    for (const w of out.slice(0, -3).split(' ')) expect(words.has(w)).toBe(true);
  });

  it('never cuts mid-word when the cap lands inside a word', () => {
    // cap 14 lands inside "abcdefghij" (chars 11-20)
    expect(excerptOf('aaaa bbbb cc abcdefghij tail', 14)).toBe('aaaa bbbb cc...');
  });

  it('keeps the word when the cap lands exactly on a boundary', () => {
    expect(excerptOf('aaaa bbbb cc dd', 12)).toBe('aaaa bbbb cc...');
  });

  it('leaves a body shorter than the cap unchanged, no ellipsis', () => {
    expect(excerptOf('short body', 200)).toBe('short body');
    expect(excerptOf('another one here', 200)).toBe('another one here');
  });

  it('a body exactly at the cap is whole, one past it is cut', () => {
    expect(excerptOf('aaaa bbbb', 9)).toBe('aaaa bbbb');
    expect(excerptOf('aaaa bbbbb', 9)).toBe('aaaa...');
  });

  it('keeps a single token longer than the cap rather than printing nothing', () => {
    const long = 'x'.repeat(30);
    expect(excerptOf(`${long} tail`, 10)).toBe(`${long}...`);
  });

  it('re-flows hard wraps into one line', () => {
    expect(excerptOf('first half\nsecond half\n\nthird', 200)).toBe('first half second half third');
  });
});

describe('weak matches', () => {
  it('is weak below the floor and not at it', () => {
    expect(isWeak(WEAK_MATCH_BELOW - 0.01)).toBe(true);
    expect(isWeak(WEAK_MATCH_BELOW)).toBe(false);
    expect(isWeak(undefined)).toBe(false);
  });
  it('a set is weak only when every scored match is', () => {
    expect(allWeak([0.3, 0.42])).toBe(true);
    expect(allWeak([0.3, 0.51])).toBe(false);
    expect(allWeak([undefined])).toBe(false);
    expect(allWeak([])).toBe(false);
  });
});

describe('withoutTitle', () => {
  it('drops a leading echo of the title', () => {
    expect(withoutTitle('fix: a thing (#1)\n\nbody text', 'fix: a thing (#1)')).toBe('body text');
    expect(withoutTitle('feat: other\nmore', 'feat: other')).toBe('more');
  });
  it('leaves a summary that does not start with the title', () => {
    expect(withoutTitle('body only', 'fix: a thing')).toBe('body only');
    expect(withoutTitle('fix: a thingy body', 'fix: a thing')).toBe('fix: a thingy body');
  });
});
