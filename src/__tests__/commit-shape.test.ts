import { describe, expect, it } from 'vitest';
import { MECHANICAL_SUBJECT_PREFIXES, mechanicalSubjectRegex } from '../lib/commit-shape.js';

/**
 * Copilot on align-cli#240 (suppressed comment, landed after the merge): the predicate
 * regex was built by interpolating the prefix list straight into a pattern. Fine for the
 * eight plain words in it today, and silently wrong the day one carries a metacharacter.
 */
describe('mechanicalSubjectRegex', () => {
  it('treats a prefix literally even when it carries regex metacharacters', () => {
    const re = mechanicalSubjectRegex(['c++', 'wip']);
    expect(re.test('c++: rebuild the parser')).toBe(true);
    // Interpolated raw, `c++` reads as "one or more c" and this would match too.
    expect(re.test('ccc: three cs is not the c++ prefix')).toBe(false);
  });

  it('builds the predicate the real list uses: every member rejects, an unlisted one does not', () => {
    const re = mechanicalSubjectRegex(MECHANICAL_SUBJECT_PREFIXES);
    for (const prefix of MECHANICAL_SUBJECT_PREFIXES) expect(re.test(`${prefix}: something`), prefix).toBe(true);
    expect(re.test('feat: something')).toBe(false);
  });

  it('is anchored to the start and case-insensitive, as the original literal was', () => {
    const re = mechanicalSubjectRegex(['chore']);
    expect(re.test('CHORE: shout it')).toBe(true);
    expect(re.test('a chore: not at the start')).toBe(false);
  });
});
