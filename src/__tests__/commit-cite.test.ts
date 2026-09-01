import { describe, expect, it } from 'vitest';
import { localCitationFor } from '../lib/commit-cite.js';

// ALI-792: git-imported decisions rendered as bare UUIDs because citationFor
// deliberately refuses commit URLs (decision-links.ts is byte-identical to
// mcp-align's copy and must stay so). This wrapper adds the commit cite for the
// CLI's local rendering without forking that file.
describe('localCitationFor', () => {
  it('cites a GitHub commit as repo@shortsha', () => {
    expect(localCitationFor('https://github.com/align/cli/commit/abc1234def5678')).toBe('cli@abc1234');
  });

  it('cites a GitLab commit through its /-/ path', () => {
    expect(localCitationFor('https://gitlab.com/align/cli/-/commit/def5678abc1234')).toBe('cli@def5678');
  });

  // Review finding (2026-09-01): buildCommitUrl emits subgroup paths for GitLab
  // subgroup remotes, and the single-segment pattern failed the whole class to
  // undefined - the bare-UUID rendering this wrapper exists to fix.
  it('cites a GitLab subgroup commit by its repo (last path segment)', () => {
    expect(localCitationFor('https://gitlab.com/group/subgroup/repo/-/commit/def5678abc1234')).toBe('repo@def5678');
  });

  it('cites a remoteless git:// commit by short sha alone', () => {
    expect(localCitationFor('git://commit/abc1234def5678')).toBe('abc1234');
  });

  it('delegates PR and ticket URLs to the shared citationFor unchanged', () => {
    expect(localCitationFor('https://github.com/align/cli/pull/78')).toBe('cli#78');
    expect(localCitationFor('https://linear.app/align/issue/ALI-788/launch')).toBe('ALI-788');
  });

  it('returns undefined for null, undefined and unciteable URLs', () => {
    expect(localCitationFor(null)).toBeUndefined();
    expect(localCitationFor(undefined)).toBeUndefined();
    expect(localCitationFor('https://example.com/some/page')).toBeUndefined();
  });
});
