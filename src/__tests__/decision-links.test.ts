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
import { citationFor, repositoryOf } from '../lib/decision-links.js';

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
