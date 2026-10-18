import { describe, expect, it } from 'vitest';
import { rerankByTitle } from '../lib/search-rerank.js';

interface Row { id: string; score: number; title: string }
const rank = (query: string, rows: Row[]) =>
  rerankByTitle(query, rows, r => r.score, r => r.title).map(r => r.id);

// Shapes taken from the real ALI-1773 miss: two titles that repeat "align setup" outscore
// the commit that actually removed it, because the dense embedding rewards the repeated noun.
const MENTION = { id: 'mention', score: 0.666, title: 'docs: update README for align why, align setup, and align mcp --setup' };
const REMOVAL = { id: 'removal', score: 0.523, title: 'feat(setup): offer saved tokens before the picker; remove align setup (#425)' };
const OTHER = { id: 'other', score: 0.5, title: 'fix(ci): cache the embedding model' };

describe('rerankByTitle', () => {
  it('lets a lexically exact, semantically lower candidate overtake a higher-scoring mention', () => {
    // The two dense scores differ on purpose: an equal pair could not tell the rerank from none.
    expect(MENTION.score).toBeGreaterThan(REMOVAL.score);
    expect(rank('why was align setup removed', [MENTION, REMOVAL, OTHER])).toEqual(['removal', 'mention', 'other']);
  });

  it('matches an inflected query verb to the stem in the title (removed -> remove)', () => {
    const a = { id: 'a', score: 0.6, title: 'docs: setup notes' };
    const b = { id: 'b', score: 0.55, title: 'feat: remove setup' };
    const c = { id: 'c', score: 0.3, title: 'chore: deps' };
    expect(rank('why was setup removed', [a, b, c])[0]).toBe('b');
  });

  it('still reorders when the query also carries a word that no title contains', () => {
    expect(rank('why was align setup removed zzzunknown', [MENTION, REMOVAL, OTHER])[0]).toBe('removal');
  });

  it('gives a weak row no boost, so it cannot climb past strong ones', () => {
    const strong = { id: 'strong', score: 0.7, title: 'feat: unrelated' };
    const weak = { id: 'weak', score: 0.3, title: 'remove align setup' };
    const mid = { id: 'mid', score: 0.5, title: 'docs: other' };
    expect(rank('why was align setup removed', [strong, mid, weak])).toEqual(['strong', 'mid', 'weak']);
  });

  it('does not treat contraction fragments as query words', () => {
    const a = { id: 'a', score: 0.6, title: 'docs: notes' };
    const b = { id: 'b', score: 0.5, title: "fix: user's t s thing" };
    expect(rank("what's the plan", [a, b])).toEqual(['a', 'b']);
  });

  it('keeps the dense order when no title shares a content word with the query', () => {
    const rows = [
      { id: 'x', score: 0.7, title: 'feat: add retries' },
      { id: 'y', score: 0.6, title: 'fix: tidy logs' },
      { id: 'z', score: 0.4, title: 'docs: typo' },
    ];
    expect(rank('why was align setup removed', rows)).toEqual(['x', 'y', 'z']);
  });

  it('does not reorder on a word every candidate carries', () => {
    const rows = [
      { id: 'x', score: 0.7, title: 'align one' },
      { id: 'y', score: 0.6, title: 'align two' },
      { id: 'z', score: 0.4, title: 'align three' },
    ];
    expect(rank('why align', rows)).toEqual(['x', 'y', 'z']);
  });

  it('breaks exact ties by input order, deterministically', () => {
    const rows = [
      { id: 'first', score: 0.5, title: 'remove setup' },
      { id: 'second', score: 0.5, title: 'remove setup' },
      { id: 'third', score: 0.5, title: 'remove setup' },
    ];
    expect(rank('why was setup removed', rows)).toEqual(['first', 'second', 'third']);
    expect(rank('why was setup removed', [...rows].reverse())).toEqual(['third', 'second', 'first']);
  });

  it('returns the same row objects, leaves the input untouched, and handles empty input', () => {
    const rows = [MENTION, REMOVAL];
    const out = rerankByTitle('why was align setup removed', rows, r => r.score, r => r.title);
    expect(out[0]).toBe(REMOVAL);
    expect(rows.map(r => r.id)).toEqual(['mention', 'removal']);
    expect(rerankByTitle('anything', [], (r: Row) => r.score, r => r.title)).toEqual([]);
  });

  it('is a no-op for a query that is only question words', () => {
    // The lower-scoring row carries "why" in its title: scaffolding must not count as content.
    const plain = { id: 'plain', score: 0.6, title: 'feat: tidy the output' };
    const why = { id: 'why', score: 0.5, title: 'fix(cli): remove why alias' };
    expect(rank('why do we', [plain, why])).toEqual(['plain', 'why']);
  });
});
