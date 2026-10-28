import { describe, expect, it } from 'vitest';
import { allWeak, excerptBody, excerptOf, isWeak, WEAK_MATCH_BELOW, withoutTitle, withoutTrailers } from '../lib/ask-listing.js';

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

describe('withoutTrailers', () => {
  it('drops Signed-off-by and Co-authored-by lines', () => {
    const body = 'Real text here\n\nSigned-off-by: A B <a@b.c>\nCo-authored-by: C D <c@d.e>';
    expect(withoutTrailers(body)).toBe('Real text here');
  });

  it('drops the other trailer keys too (Reviewed-by, Acked-by, Tested-by, Reported-by, Change-Id)', () => {
    const body = 'Why we did it\nReviewed-by: x\nAcked-by: y\nTested-by: z\nReported-by: w\nChange-Id: I123';
    expect(withoutTrailers(body)).toBe('Why we did it');
  });

  it('drops Cc and Suggested-by trailers too, from the one shared list', () => {
    expect(withoutTrailers('Body\nCc: someone@example.test\nSuggested-by: Q <q@r.s>')).toBe('Body');
    expect(withoutTrailers('Body\nHelped-by: Z\nReviewed-on: https://x.test/1')).toBe('Body');
  });

  it('strips a trailing "Issue: #123" after a blank line but keeps an opening "Issue: <reason>" line', () => {
    const body = 'Issue: users get a 500 when the token expires\n\nThe handler now refreshes first.\n\nIssue: #123';
    expect(withoutTrailers(body)).toBe('Issue: users get a 500 when the token expires\n\nThe handler now refreshes first.');
    expect(withoutTrailers('Bug: crash on empty input\n\nFixed the guard.\n\nBug: #9')).toBe('Bug: crash on empty input\n\nFixed the guard.');
  });

  it('strips only the trailing block: a mid-body trailer-looking line and a mid-body rule survive', () => {
    const body = 'Intro.\n\nCc: mid-body note\n\n---\n\nMore text.\n\nSigned-off-by: A <a@b.c>';
    expect(withoutTrailers(body)).toBe('Intro.\n\nCc: mid-body note\n\n---\n\nMore text.');
  });

  it('strips fastify-style squash tails whole', () => {
    const body = 'Subject line\n\n---------\n\nSigned-off-by: A <a@b.c>\nCo-authored-by: B <b@c.d>\nCo-authored-by: C <c@d.e>';
    expect(withoutTrailers(body)).toBe('Subject line');
  });

  it('drops the dashed separator a squash merge adds', () => {
    expect(withoutTrailers('Body\n\n---------\n\nSigned-off-by: A <a@b.c>')).toBe('Body');
    expect(withoutTrailers('Body\n-----\nCo-authored-by: A <a@b.c>')).toBe('Body');
  });

  it('keeps real text that sits next to trailers', () => {
    const body = 'First paragraph.\n\nSecond paragraph.\n\nSigned-off-by: A <a@b.c>';
    expect(withoutTrailers(body)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('keeps a line that only mentions signed-off-by mid-sentence', () => {
    const body = 'We now require a signed-off-by line on every commit.\nThe DCO bot checks Signed-off-by: presence.';
    expect(withoutTrailers(body)).toBe(body);
  });
});

describe('excerptBody', () => {
  const title = 'fix: clamp error statusCode between 400 and 599 with 500 fallback (#7089)';
  const meta = '\n\nAuthor: A\n\nDate: 2026-10-15T15:01:35+05:30\n\nURL: https://example.test/c/1';

  it('is empty when the body is only trailers', () => {
    const summary = `${title}\n\n---------\n\nSigned-off-by: A <a@b.c>\nCo-authored-by: B <b@c.d>${meta}`;
    expect(excerptBody(summary, title)).toBe('');
  });

  it('is empty for a second, different trailer-only body', () => {
    const summary = `fix: other\n\nReviewed-by: Q\nChange-Id: I1${meta}`;
    expect(excerptBody(summary, 'fix: other')).toBe('');
  });

  it('is empty when the leftover only repeats the title, ignoring case, spacing and a PR ref', () => {
    expect(excerptBody('fix: clamp the code (#12)', 'Fix: Clamp  the code (#7)')).toBe('');
  });

  it('keeps the real text and drops the trailers', () => {
    const summary = `${title}\n\nThe handler crashed on 700 because the range was unchecked.\n\n---------\n\nSigned-off-by: A <a@b.c>${meta}`;
    expect(excerptBody(summary, title)).toBe('The handler crashed on 700 because the range was unchecked.');
  });

  it('keeps a mid-sentence mention of signed-off-by', () => {
    const summary = `${title}\n\nWe require a signed-off-by line now.${meta}`;
    expect(excerptBody(summary, title)).toBe('We require a signed-off-by line now.');
  });
});
