import { describe, expect, it } from 'vitest';
import { expandedTerms, QUOTED_WEIGHT } from '../lib/query-expand.js';

describe('expandedTerms', () => {
  it('drops the scaffolding and keeps the content words at full weight', () => {
    const t = expandedTerms('why was the legacy parser removed');
    expect(t.get('legacy')).toBe(1);
    expect(t.get('parser')).toBe(1);
    expect(t.has('why')).toBe(false);
  });
  it('does not add synonyms of the verb', () => {
    expect([...expandedTerms('why was foo dropped').keys()].sort()).toEqual(['drop', 'foo']);
  });
  it('a plain question yields only its content words', () => {
    expect([...expandedTerms('why do we use pino').keys()]).toEqual(['pino']);
  });
  it('counts a quoted phrase or a backticked identifier double', () => {
    expect(expandedTerms('why was `find-my-way` dropped').get('find-my-way')).toBe(QUOTED_WEIGHT);
    expect(expandedTerms('why was "legacy mode" dropped').get('legacy')).toBe(QUOTED_WEIGHT);
  });
});
