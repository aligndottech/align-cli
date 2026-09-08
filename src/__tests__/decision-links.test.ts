/**
 * citationFor renders a decision the way a human cites one. For code that is
 * "repo#123" (align-cli#76); for trackers it is the ticket key humans already
 * say out loud - "ALI-346", "PROJ-123". Session A (2026-08-25) showed the gap:
 * the Linear source in a cross-tool answer was the one line still wearing a
 * raw UUID, with its key sitting visibly in the URL beside it.
 *
 * repositoryOf must NOT learn these forms: a Linear issue has no repository,
 * and the CODE_REF docblock's whole point is refusing to invent one.
 */
import { describe, expect, it } from 'vitest';
import {
  citationFor,
  isSyntheticSource,
  navigableSourceUrl,
  repositoryOf,
  SYNTHETIC_SOURCE_PREFIXES,
} from '../lib/decision-links.js';

describe('citationFor', () => {
  it('cites a GitHub PR as repo#number (existing contract, pinned)', () => {
    expect(citationFor('https://github.com/aligndottech/align-stack/pull/1582')).toBe('align-stack#1582');
  });

  it('cites a Linear issue by its ticket key', () => {
    expect(
      citationFor('https://linear.app/aligndottech/issue/ALI-346/one-writer-for-prod-image-tags'),
    ).toBe('ALI-346');
  });

  it('cites a Linear issue with no title slug', () => {
    expect(citationFor('https://linear.app/aligndottech/issue/ALI-346')).toBe('ALI-346');
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
    expect(repositoryOf('https://linear.app/aligndottech/issue/ALI-346/title')).toBeUndefined();
  });

  it('a Jira issue does NOT', () => {
    expect(repositoryOf('https://acme.atlassian.net/browse/PROJ-123')).toBeUndefined();
  });
});

/**
 * ALI-923: align-cli reads decisions from the HOSTED gateway too (align context sync,
 * align why), and a hosted decision can carry a synthetic align://claimed/... or
 * align://unsourced/... identity (ALI-538) instead of a real source - not a place anyone
 * can open. Ported from align-stack's per-connector syntheticSource.ts (ALI-567). Two
 * examples per rule (tdd.md): a synthetic case AND a real case for each function, not just
 * the happy path.
 */
describe('isSyntheticSource (ALI-923)', () => {
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

describe('navigableSourceUrl (ALI-923)', () => {
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

describe('SYNTHETIC_SOURCE_PREFIXES (ALI-923)', () => {
  it('matches the two namespaces align-stack currently mints (ALI-538)', () => {
    // A zero-match parse or a shrunk list would pass every test above vacuously - pin the
    // exact set rather than only exercising it indirectly.
    expect([...SYNTHETIC_SOURCE_PREFIXES].sort()).toEqual(['align://claimed/', 'align://unsourced/']);
  });
});
