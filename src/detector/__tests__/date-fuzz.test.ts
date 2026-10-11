/**
 * Review R1: parseDecidedAt must accept exactly what the brain's parse_decided_at accepts, and
 * land on the same microsecond. date-fuzz-corpus.json holds mutated ISO-ish strings with
 * Python 3.14's own verdict (scripts/gen-date-fuzz.py). "error" means Python RAISES rather than
 * returning None; the port returns null there (no date, the safe reading).
 */
import { describe, expect, it } from 'vitest';
import corpus from '../date-fuzz-corpus.json' with { type: 'json' };
import { parseDecidedAt } from '../resolve-pair.js';

describe('parseDecidedAt matches Python 3.14 on the fuzz corpus', () => {
  it('positive control: the corpus is big and holds both verdicts', () => {
    expect(corpus.python.startsWith('3.14')).toBe(true);
    expect(corpus.cases.length).toBeGreaterThan(3000);
    expect(corpus.cases.some(([, v]) => v === null)).toBe(true);
    expect(corpus.cases.some(([, v]) => v === 'error')).toBe(true);
    expect(corpus.cases.filter(([, v]) => typeof v === 'string' && v !== 'error').length).toBeGreaterThan(250);
  });

  it('every case agrees', () => {
    const diffs = (corpus.cases as Array<[string, string | null]>)
      .map(([input, want]) => ({ input, want: want === 'error' ? null : want, got: parseDecidedAt(input)?.toString() ?? null }))
      .filter((d) => d.got !== d.want);
    expect(diffs.slice(0, 20), `${diffs.length} disagreement(s)`).toEqual([]);
  });
});
