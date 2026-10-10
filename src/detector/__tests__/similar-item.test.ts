import { describe, expect, it } from 'vitest';
import { NEW_DECISION_REF, resolveSimilarItem } from '../similar-item.js';
import type { ParsedRelationshipItem } from '../relationship-contract.js';

const ev = { new_quote: 'cap the pool at 12', existing_quote: 'pool max 40' };
const item = (over: Partial<ParsedRelationshipItem>): ParsedRelationshipItem => ({ type: 'incompatible', confidence: 0.9, reason: 'r', evidence: ev, replaced: null, ...over });
const side = (id: string, decidedAt: string | null) => ({ id, decidedAt, author: null });

describe('resolveSimilarItem (port of resolve_similar_relationships, one entry)', () => {
  it('a non-verdict type passes through unchanged', () => {
    expect(resolveSimilarItem(item({ type: 'relates', evidence: null }), side(NEW_DECISION_REF, null), side('c', null)))
      .toEqual({ type: 'relates', confidence: 0.9, reason: 'r' });
    expect(resolveSimilarItem(item({ type: 'refines', evidence: null }), side(NEW_DECISION_REF, null), side('c', null)))
      .toEqual({ type: 'refines', confidence: 0.9, reason: 'r' });
  });

  it('incompatible with no dates -> conflicts_with (never the model label)', () => {
    expect(resolveSimilarItem(item({}), side(NEW_DECISION_REF, null), side('c', null))?.type).toBe('conflicts_with');
    expect(resolveSimilarItem(item({ replaced: 'new' }), side(NEW_DECISION_REF, null), side('c', '2026-01-01'))?.type).toBe('conflicts_with');
  });

  it('incompatible, new is 3 days later and its text replaces the other -> supersedes new->candidate', () => {
    expect(resolveSimilarItem(item({ replaced: 'new' }), side(NEW_DECISION_REF, '2026-01-04'), side('c', '2026-01-01'))?.type).toBe('supersedes');
  });

  it('replaced names the existing side while new is later -> conflicts_with (claim disagrees with clock)', () => {
    expect(resolveSimilarItem(item({ replaced: 'existing' }), side(NEW_DECISION_REF, '2026-01-04'), side('c', '2026-01-01'))?.type).toBe('conflicts_with');
  });

  it('the candidate is later and replaces the new one -> degrades to conflicts_with with the fallback reason', () => {
    const r = resolveSimilarItem(item({ replaced: 'existing' }), side(NEW_DECISION_REF, '2026-01-01'), side('c', '2026-01-04'));
    expect(r?.type).toBe('conflicts_with');
    expect(r?.reason).toMatch(/existing decision is more recent/);
  });

  it('a retired candidate -> no edge (null)', () => {
    expect(resolveSimilarItem(item({}), side(NEW_DECISION_REF, null), { ...side('c', null), status: 'superseded' })).toBeNull();
  });
});
