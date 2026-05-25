import { describe, expect, it } from 'vitest';
import { normaliseWhyQuery } from '../lib/why-normalise.js';

describe('normaliseWhyQuery', () => {
  it('strips "why do we"', () =>
    expect(normaliseWhyQuery('why do we use postgres')).toBe('use postgres'));

  it('strips "why does"', () =>
    expect(normaliseWhyQuery('why does the auth module use JWT')).toBe('the auth module use JWT'));

  it('strips "why did we"', () =>
    expect(normaliseWhyQuery('why did we migrate to GraphQL')).toBe('migrate to GraphQL'));

  it('strips "why is"', () =>
    expect(normaliseWhyQuery('why is session storage avoided')).toBe('session storage avoided'));

  it('strips bare "why"', () =>
    expect(normaliseWhyQuery('why postgres')).toBe('postgres'));

  it('strips "do we"', () =>
    expect(normaliseWhyQuery('do we use postgres')).toBe('use postgres'));

  it('strips "does it"', () =>
    expect(normaliseWhyQuery('does it use redis')).toBe('use redis'));

  it('strips "what do we"', () =>
    expect(normaliseWhyQuery('what do we use for caching')).toBe('use for caching'));

  it('strips "what does it"', () =>
    expect(normaliseWhyQuery('what does it use for auth')).toBe('use for auth'));

  it('strips "what is"', () =>
    expect(normaliseWhyQuery('what is the auth strategy')).toBe('the auth strategy'));

  it('strips "how does"', () =>
    expect(normaliseWhyQuery('how does the queue work')).toBe('the queue work'));

  it('strips "how do we"', () =>
    expect(normaliseWhyQuery('how do we handle caching')).toBe('handle caching'));

  it('does not mangle a plain noun query', () =>
    expect(normaliseWhyQuery('postgres database choice')).toBe('postgres database choice'));

  it('is case-insensitive on the prefix', () =>
    expect(normaliseWhyQuery('Why Do We use postgres')).toBe('use postgres'));

  it('trims leading and trailing whitespace', () =>
    expect(normaliseWhyQuery('  why do we use postgres  ')).toBe('use postgres'));

  it('does not strip when result would be empty', () =>
    expect(normaliseWhyQuery('why')).toBe('why'));

  it('handles "why are we" prefix', () =>
    expect(normaliseWhyQuery('why are we using typescript')).toBe('using typescript'));
});
