/**
 * The relationship contract: golden parse vectors, the vocabulary rules, and the boundaries
 * that must be read from the contract and never hard-coded in the parser.
 *
 * This file is vendored byte for byte into align-stack's packages/llm-eval and is pinned by
 * relationship-contract.lock there. The same parse-vectors.json also runs in the Python parser
 * in the brain. Edit it here and re-run scripts/sync-relationship-contract.sh in align-stack;
 * never edit a copy.
 */
import { describe, expect, it } from 'vitest';
import vectors from '../parse-vectors.json' with { type: 'json' };
import {
  contractProblems,
  parseRelationshipItem,
  RELATIONSHIP_CONTRACT,
  type RelationshipContract,
} from '../relationship-contract.js';

const asciiWords = (s: string): number => s.split(/[ \t\n\r]+/).filter((w) => w !== '').length;
const fixture = (edit: (c: any) => void): RelationshipContract => {
  const c = structuredClone(RELATIONSHIP_CONTRACT) as any;
  edit(c);
  return c as RelationshipContract;
};

describe('positive controls', () => {
  it('the vectors and the contract loaded', () => {
    expect(vectors.cases.length).toBeGreaterThan(40);
    expect(RELATIONSHIP_CONTRACT.types).toContain('supersedes');
    expect(RELATIONSHIP_CONTRACT.offers.v1Candidate).toContain('incompatible');
  });
});

describe('golden parse vectors', () => {
  it.each(vectors.cases)('$name', (c) => {
    expect(parseRelationshipItem(c.raw, c.offer as 'legacyV0' | 'v1Candidate')).toEqual(c.expected);
  });

  it('the word-cap vectors sit on both sides of parse.evidenceMaxWords', () => {
    const max = RELATIONSHIP_CONTRACT.parse.evidenceMaxWords;
    const quotes = (name: string): [string, string] => {
      const c = vectors.cases.find((v) => v.name === name);
      expect(c, `vector "${name}" is missing`).toBeDefined();
      const ev = (JSON.parse(c!.raw) as any).evidence;
      return [ev.new_quote, ev.existing_quote];
    };
    expect(asciiWords(quotes('evidence at exactly the word cap is accepted')[0])).toBe(max);
    expect(asciiWords(quotes('evidence at exactly the word cap is accepted')[1])).toBe(max);
    expect(asciiWords(quotes('evidence-16-words-clipped')[0])).toBe(max + 1);
    expect(asciiWords(quotes('evidence-40-words-clipped')[0])).toBe(40);
    expect(asciiWords(quotes('evidence over the word cap on the existing side is clipped')[1])).toBe(max + 1);
    expect(asciiWords(quotes('a non-breaking space does not split a word')[0])).toBe(max);
    expect(asciiWords(quotes('tabs and newlines separate words')[0])).toBe(max);
  });
});

describe('the parser reads its rules from the contract', () => {
  const evidence = (n: number) => ({
    new_quote: Array.from({ length: n }, (_, i) => `n${i}`).join(' '),
    existing_quote: 'it stays',
  });
  const incompatible = (n: number) =>
    JSON.stringify({ type: 'incompatible', confidence: 0.8, reason: 'x', evidence: evidence(n), replaced: 'new' });

  it('the clip length moves with parse.evidenceMaxWords (3 words kept as is, 4 clipped to 3)', () => {
    const c = fixture((x) => { x.parse.evidenceMaxWords = 3; });
    expect(parseRelationshipItem(incompatible(3), 'v1Candidate', c)?.evidence?.new_quote).toBe('n0 n1 n2');
    expect(parseRelationshipItem(incompatible(4), 'v1Candidate', c)?.evidence?.new_quote).toBe('n0 n1 n2');
  });

  it('the clip length moves with parse.evidenceMaxWords (20 kept as is, 21 clipped to 20)', () => {
    const c = fixture((x) => { x.parse.evidenceMaxWords = 20; });
    const words = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
    expect(parseRelationshipItem(incompatible(20), 'v1Candidate', c)?.evidence?.new_quote).toBe(words(20).join(' '));
    expect(parseRelationshipItem(incompatible(21), 'v1Candidate', c)?.evidence?.new_quote).toBe(words(20).join(' '));
  });

  it('a quote within the limit is returned exactly as written, spacing included', () => {
    const raw = JSON.stringify({ type: 'incompatible', confidence: 0.8, reason: 'x', evidence: { new_quote: ' a\tb  c ', existing_quote: 'it\nstays' } });
    expect(parseRelationshipItem(raw, 'v1Candidate')?.evidence).toEqual({ new_quote: ' a\tb  c ', existing_quote: 'it\nstays' });
  });

  it('a clipped quote is the first words joined by single spaces', () => {
    const c = fixture((x) => { x.parse.evidenceMaxWords = 3; });
    const raw = JSON.stringify({ type: 'incompatible', confidence: 0.8, reason: 'x', evidence: { new_quote: 'a\tb\n\nc   d e', existing_quote: 'p q r s' } });
    expect(parseRelationshipItem(raw, 'v1Candidate', c)?.evidence).toEqual({ new_quote: 'a b c', existing_quote: 'p q r' });
  });

  it('the default confidence moves with parse.confidenceDefault', () => {
    const c = fixture((x) => { x.parse.confidenceDefault = 0.25; });
    expect(parseRelationshipItem('{"type":"relates"}', 'legacyV0', c)?.confidence).toBe(0.25);
    const d = fixture((x) => { x.parse.confidenceDefault = 0.75; });
    expect(parseRelationshipItem('{"type":"relates"}', 'legacyV0', d)?.confidence).toBe(0.75);
  });

  it('the clamp moves with parse.confidenceClamp, both edges', () => {
    const c = fixture((x) => { x.parse.confidenceClamp = [0.2, 0.8]; });
    expect(parseRelationshipItem('{"type":"relates","confidence":0.9}', 'legacyV0', c)?.confidence).toBe(0.8);
    expect(parseRelationshipItem('{"type":"relates","confidence":0.1}', 'legacyV0', c)?.confidence).toBe(0.2);
    expect(parseRelationshipItem('{"type":"relates","confidence":0.5}', 'legacyV0', c)?.confidence).toBe(0.5);
  });

  it('the verdict type moves with verdictTypes (evidence is required for whatever it names)', () => {
    const c = fixture((x) => { x.verdictTypes = ['blocks']; });
    expect(parseRelationshipItem('{"type":"blocks","confidence":0.5}', 'legacyV0', c)).toBeNull();
    expect(parseRelationshipItem('{"type":"relates","confidence":0.5}', 'legacyV0', c)).not.toBeNull();
  });

  it('an unknown offer name throws and names the allowed ones, never falls back', () => {
    expect(() => parseRelationshipItem('{}', 'v2' as never)).toThrow(/legacyV0.*v1Candidate/);
    expect(() => parseRelationshipItem('{}', 'toString' as never)).toThrow(/legacyV0/);
  });
});

describe('parse.evidenceOverflow', () => {
  it('the shipped contract says clip', () => {
    expect(RELATIONSHIP_CONTRACT.parse.evidenceOverflow).toBe('clip');
  });

  it('a missing value is a problem', () => {
    const c = fixture((x) => { delete x.parse.evidenceOverflow; });
    expect(contractProblems(c).join('\n')).toMatch(/evidenceOverflow/);
  });

  it('any value other than clip is a problem (two examples)', () => {
    for (const v of ['reject', 'truncate']) {
      const c = fixture((x) => { x.parse.evidenceOverflow = v; });
      expect(contractProblems(c).join('\n')).toMatch(/evidenceOverflow.*"clip"/);
    }
  });
});

describe('contractProblems (offer lists and families against the type list)', () => {
  it('the shipped contract has no problems', () => {
    expect(contractProblems(RELATIONSHIP_CONTRACT)).toEqual([]);
  });

  it('an offer list holding a type outside `types` is a problem that names the type', () => {
    const c = fixture((x) => { x.offers.v1Candidate.push('unrelated_to'); });
    expect(contractProblems(c).join('\n')).toMatch(/v1Candidate.*unrelated_to/);
  });

  it('the same holds for the legacy list', () => {
    const c = fixture((x) => { x.offers.legacyV0.push('depends_on'); });
    expect(contractProblems(c).join('\n')).toMatch(/legacyV0.*depends_on/);
  });

  it('removing a type that an offer still lists is a problem (the other direction)', () => {
    const c = fixture((x) => { x.types = x.types.filter((t: string) => t !== 'refines'); });
    const problems = contractProblems(c).join('\n');
    expect(problems).toMatch(/legacyV0.*refines/);
    expect(problems).toMatch(/v1Candidate.*refines/);
  });

  it('a verdict type in an offer list is allowed', () => {
    expect(RELATIONSHIP_CONTRACT.offers.v1Candidate).toContain('incompatible');
    expect(contractProblems(RELATIONSHIP_CONTRACT).join('\n')).not.toMatch(/incompatible/);
  });

  it('a verdict type that is also a stored type is a problem', () => {
    const c = fixture((x) => { x.types.push('incompatible'); });
    expect(contractProblems(c).join('\n')).toMatch(/incompatible.*verdict/);
  });

  it('a conflict-family member outside `types` is a problem', () => {
    const c = fixture((x) => { x.conflictFamily.push('opposes'); });
    expect(contractProblems(c).join('\n')).toMatch(/conflictFamily.*opposes/);
  });

  it('a duplicate in `types` is a problem', () => {
    const c = fixture((x) => { x.types.push('relates'); });
    expect(contractProblems(c).join('\n')).toMatch(/duplicate.*relates/);
  });
});
