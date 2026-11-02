/**
 * citationFor renders a decision the way a human cites one. For code that is
 * "repo#123" (align-cli#76); for trackers it is the ticket key humans already
 * say out loud - "APP-346", "PROJ-123". Session A (2026-08-25) showed the gap:
 * the Linear source in a cross-tool answer was the one line still wearing a
 * raw UUID, with its key sitting visibly in the URL beside it.
 *
 * repositoryOf must NOT learn these forms: a Linear issue has no repository,
 * and the CODE_REF docblock's whole point is refusing to invent one.
 */
import { describe, expect, it } from 'vitest';
import {
  citationFor,
  decisionLinkFor,
  isSyntheticSource,
  navigableSourceUrl,
  repositoryOf,
  SYNTHETIC_SOURCE_PREFIXES,
  withoutUnopenableSources,
} from '../lib/decision-links.js';

describe('citationFor', () => {
  it('cites a GitHub PR as repo#number (existing contract, pinned)', () => {
    expect(citationFor('https://github.com/aligndottech/align-stack/pull/1582')).toBe('align-stack#1582');
  });

  it('cites a Linear issue by its ticket key', () => {
    expect(
      citationFor('https://linear.app/aligndottech/issue/APP-346/one-writer-for-prod-image-tags'),
    ).toBe('APP-346');
  });

  it('cites a Linear issue with no title slug', () => {
    expect(citationFor('https://linear.app/aligndottech/issue/APP-346')).toBe('APP-346');
  });

  it('cites a Jira issue by its ticket key', () => {
    expect(citationFor('https://acme.atlassian.net/browse/PROJ-123')).toBe('PROJ-123');
  });

  it('returns undefined for URLs with no citable form (a Slack archive)', () => {
    expect(citationFor('https://acme.slack.com/archives/C1/p123')).toBeUndefined();
  });

  it('does not mistake a Linear workspace path for a ticket', () => {
    // The key must be a real KEY-123 form; a bare word in the issue slot is not one.
    expect(citationFor('https://linear.app/aligndottech/issue/not-a-key/title')).toBeUndefined();
  });
});

describe('repositoryOf refuses to invent repositories (the CODE_REF promise)', () => {
  it('a GitHub PR has one', () => {
    expect(repositoryOf('https://github.com/aligndottech/align-stack/pull/1582')).toBe('aligndottech/align-stack');
  });

  it('a Linear issue does NOT - the workspace is not an owner and the key is not a repo', () => {
    expect(repositoryOf('https://linear.app/aligndottech/issue/APP-346/title')).toBeUndefined();
  });

  it('a Jira issue does NOT', () => {
    expect(repositoryOf('https://acme.atlassian.net/browse/PROJ-123')).toBeUndefined();
  });
});

/**
 * Align-cli reads decisions from the HOSTED gateway too (align context sync,
 * align why), and a hosted decision can carry a synthetic align://claimed/... or
 * align://unsourced/... identity instead of a real source - not a place anyone
 * can open. Ported from align-stack's per-connector syntheticSource.ts. Two
 * examples per rule (tdd.md): a synthetic case AND a real case for each function, not just
 * the happy path.
 */
describe('isSyntheticSource', () => {
  it('recognises the claimed namespace', () => {
    expect(isSyntheticSource('align://claimed/9f2c')).toBe(true);
  });

  it('recognises the unsourced namespace', () => {
    expect(isSyntheticSource('align://unsourced/9f2c')).toBe(true);
  });

  it('a real https source is not synthetic', () => {
    expect(isSyntheticSource('https://github.com/align/repo/pull/42')).toBe(false);
  });

  it('a real source-like string with no matching prefix is not synthetic', () => {
    expect(isSyntheticSource('https://acme.slack.com/archives/C1/p123')).toBe(false);
  });

  it('uses startsWith, not includes: a real page may carry the text in its path', () => {
    expect(isSyntheticSource('https://example.test/docs/align://claimed/x')).toBe(false);
  });

  it('is false for undefined and null, never throws', () => {
    expect(isSyntheticSource(undefined)).toBe(false);
    expect(isSyntheticSource(null)).toBe(false);
  });
});

describe('navigableSourceUrl', () => {
  it('returns undefined for a synthetic claimed url - not a place anyone can open', () => {
    expect(navigableSourceUrl('align://claimed/9f2c')).toBeUndefined();
  });

  it('returns undefined for a synthetic unsourced url', () => {
    expect(navigableSourceUrl('align://unsourced/9f2c')).toBeUndefined();
  });

  it('returns a real url unchanged, so a genuine source still navigates normally', () => {
    expect(navigableSourceUrl('https://github.com/align/repo/pull/42')).toBe(
      'https://github.com/align/repo/pull/42',
    );
  });

  it('returns a real Jira url unchanged', () => {
    expect(navigableSourceUrl('https://acme.atlassian.net/browse/PROJ-123')).toBe(
      'https://acme.atlassian.net/browse/PROJ-123',
    );
  });

  it('returns undefined for undefined, null and empty string - never a placeholder', () => {
    expect(navigableSourceUrl(undefined)).toBeUndefined();
    expect(navigableSourceUrl(null)).toBeUndefined();
    expect(navigableSourceUrl('')).toBeUndefined();
  });
});

describe('SYNTHETIC_SOURCE_PREFIXES', () => {
  it('matches the two namespaces align-stack currently mints', () => {
    // A zero-match parse or a shrunk list would pass every test above vacuously - pin the
    // exact set rather than only exercising it indirectly.
    expect([...SYNTHETIC_SOURCE_PREFIXES].sort()).toEqual(['align://claimed/', 'align://unsourced/']);
  });
});

// ALI-2039: a seeded or minted align:// identity is not a place anyone can go. A model printed
// "Decision link: align://demo/..." in a demo, and the human commands did the same. The two kinds the CLI
// already knew (claimed, unsourced) were hidden; the seeded and override kinds were not.
describe('align:// identities that are not places', () => {
  it.each([
    'align://demo/pagewell-pay/engineering/retries-service-owns-retries',
    'align://starter-template/general/no-secrets',
    'align://starter-intent/win-rate',
    'align://override-ask/ask-1/abc123',
    'align://claimed/9f2c1e',
    'align://unsourced/77aa',
  ])('navigableSourceUrl hides %s', (src) => {
    expect(navigableSourceUrl(src)).toBeUndefined();
  });

  it.each(['https://github.com/pagewell-uk/disputes/pull/7', 'http://localhost:3000/x', 'mailto:align://demo/x', 'https://example.com/align://demo/x'])(
    'navigableSourceUrl keeps the real url %s',
    (src) => {
      expect(navigableSourceUrl(src)).toBe(src);
    }
  );
});

describe('decisionLinkFor', () => {
  it('is the source url when there is a real one, even with a decision_url beside it', () => {
    expect(decisionLinkFor({ url: 'https://github.com/o/r/pull/7', decision_url: 'https://app.test/decisions/d-1' })).toBe(
      'https://github.com/o/r/pull/7'
    );
  });

  it.each(['align://demo/x', 'align://starter-template/y/z'])('falls back to the decision_url when the url is %s', (src) => {
    expect(decisionLinkFor({ url: src, decision_url: 'https://app.test/decisions/d-1' })).toBe('https://app.test/decisions/d-1');
  });

  it('uses the decision_url when there is no url at all', () => {
    expect(decisionLinkFor({ decision_url: 'https://app.test/decisions/d-2' })).toBe('https://app.test/decisions/d-2');
  });

  it('is undefined when there is nothing that opens, never the align:// value', () => {
    expect(decisionLinkFor({ url: 'align://demo/x' })).toBeUndefined();
    expect(decisionLinkFor({})).toBeUndefined();
  });
});

describe('withoutUnopenableSources', () => {
  it('drops a seeded url and source_url, at any depth, and keeps the rest of the row', () => {
    const out = withoutUnopenableSources({
      relevant_decisions: [{ id: 'd-1', title: 't', url: 'align://demo/a', decision_url: 'https://app.test/decisions/d-1' }],
      results: [{ id: 'd-2', source_url: 'align://starter-intent/b', later_on_topic: [{ id: 'd-3', source_url: 'align://override-ask/c' }] }],
    }) as any;
    expect(out.relevant_decisions[0]).toEqual({ id: 'd-1', title: 't', decision_url: 'https://app.test/decisions/d-1' });
    expect(out.results[0]).not.toHaveProperty('source_url');
    expect(out.results[0].later_on_topic[0]).not.toHaveProperty('source_url');
    expect(out.results[0].later_on_topic[0].id).toBe('d-3');
  });

  it.each([
    ['align://claimed/9f2c1e', 'claimed'],
    ['align://unsourced/77aa', 'unsourced'],
  ])('marks a %s identity unverified instead of printing it', (src) => {
    const out = withoutUnopenableSources({ results: [{ id: 'd-1', source_url: src }] }) as any;
    expect(out.results[0]).not.toHaveProperty('source_url');
    expect(out.results[0].source_unverified).toBe(true);
  });

  it('carries the model claim, trimmed, when decision_json has one, and none when it is blank', () => {
    const withClaim = withoutUnopenableSources({ r: [{ source_url: 'align://claimed/a', decision_json: { claimed_source: '  the Q3 planning doc ' } }] }) as any;
    expect(withClaim.r[0].claimed_source).toBe('the Q3 planning doc');
    const blank = withoutUnopenableSources({ r: [{ source_url: 'align://claimed/a', decision_json: { claimed_source: '   ' } }] }) as any;
    expect(blank.r[0]).not.toHaveProperty('claimed_source');
    expect(blank.r[0].source_unverified).toBe(true);
  });

  it('does not mark a seeded identity unverified: it is not a claim, only not a place', () => {
    const out = withoutUnopenableSources({ r: [{ url: 'align://demo/x' }] }) as any;
    expect(out.r[0]).not.toHaveProperty('source_unverified');
    expect(out.r[0]).not.toHaveProperty('url');
  });

  it('leaves a real url, decision_url and review_url exactly as they were', () => {
    const body = {
      review_url: 'https://app.test/review/r-1',
      relevant_decisions: [{ id: 'd-1', url: 'https://github.com/o/r/pull/7', decision_url: 'https://app.test/decisions/d-1' }],
    };
    expect(withoutUnopenableSources(body)).toEqual(body);
  });

  it('hands a Date, which is not a plain object, on unchanged', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const out = withoutUnopenableSources({ r: [{ id: 'd-1', created_at: at, url: 'align://demo/x' }] }) as any;
    expect(out.r[0].created_at).toBe(at);
    expect(out.r[0]).not.toHaveProperty('url');
  });

  it('does not change its input', () => {
    const body = { r: [{ id: 'd-1', url: 'align://demo/x' }] };
    const before = JSON.stringify(body);
    withoutUnopenableSources(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it.each([[null], [undefined], ['text'], [42], [[1, 'a', null]]])('passes %j through untouched', (v) => {
    expect(withoutUnopenableSources(v)).toEqual(v);
  });
});
