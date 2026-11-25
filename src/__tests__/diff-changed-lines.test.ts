import { describe, expect, it } from 'vitest';
import { changedLinesOf } from '../lib/diff-changed-lines.js';

const wrap = (hunk: string[]) => ['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ...hunk, ''].join('\n');

describe('changedLinesOf', () => {
  it('returns the removed lines then the added ones, without markers, headers or context', () => {
    expect(changedLinesOf(wrap([' keep', '-old', '+new', ' keep too']))).toBe('old\nnew');
  });
  it('keeps a removed SQL comment and an added increment, which look like file headers', () => {
    expect(changedLinesOf(wrap(['--- a comment', '+++i;']))).toBe('-- a comment\n++i;');
  });
  it('skips the file header of every file in the diff', () => {
    const two = [wrap(['-a', '+b']), wrap(['-c', '+d'])].join('');
    expect(changedLinesOf(two)).toBe('a\nc\nb\nd');
  });
  it('drops the carriage return of a CRLF diff', () => {
    expect(changedLinesOf(wrap(['-old', '+new']).replace(/\n/g, '\r\n'))).toBe('old\nnew');
  });
  it('is empty for a diff with no changed lines, and for text that is not a diff', () => {
    expect(changedLinesOf('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n')).toBe('');
    expect(changedLinesOf('- a bullet\n- another bullet')).toBe('');
  });
});
