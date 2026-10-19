import { describe, expect, it } from 'vitest';
import { commitBodyOf, INDEX_BODY_CHARS, indexBodyFor } from '../lib/lexical-text.js';

const summary = (title: string, body: string) => `${title}\n\n${body}\n\nAuthor: A <a@b.c>\nDate: 2025-01-01\nFiles changed:\n- src/x.ts\nURL: https://github.com/o/r/commit/abc`;

describe('commitBodyOf', () => {
  it('drops the subject, the Author/Date/Files/URL block and trailers', () => {
    const s = summary('drop node 14', 'Node 14 is end of life.\n\nCo-authored-by: B <b@c.d>\nCloses: #12');
    expect(commitBodyOf('drop node 14', s)).toBe('Node 14 is end of life.');
  });
  it('keeps a body line that merely mentions the word Author', () => {
    expect(commitBodyOf('t', summary('t', 'The Author field was wrong.'))).toBe('The Author field was wrong.');
  });
});

describe('indexBodyFor', () => {
  it('clips a long body at a word boundary near INDEX_BODY_CHARS', () => {
    const body = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const out = indexBodyFor('t', summary('t', body));
    expect(out.length).toBeLessThanOrEqual(INDEX_BODY_CHARS);
    expect(out.length).toBeGreaterThan(INDEX_BODY_CHARS * 0.6);
    expect(body.startsWith(out)).toBe(true);
    expect(out.endsWith(' ')).toBe(false);
  });
  it('returns a short body whole', () => {
    expect(indexBodyFor('t', summary('t', 'short reason here'))).toBe('short reason here');
  });
});
