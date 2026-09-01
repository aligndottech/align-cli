import { describe, expect, it } from 'vitest';
import { extractRefs } from '../lib/decision-refs.js';

// ALI-792: the refs a decision's text carries are the foundation of the gap-driven
// connect prompt ("12 decisions cite Jira keys I can't read"). Every shape here is one
// the old import threw away with the commit body.
describe('extractRefs', () => {
  it('extracts ticket keys from prose', () => {
    const refs = extractRefs('We decided against sessions. Refs ALI-123 and PROJ-9.');
    expect(refs).toContainEqual({ ref: 'ALI-123', platform: 'tracker' });
    expect(refs).toContainEqual({ ref: 'PROJ-9', platform: 'tracker' });
  });

  it('extracts #N pull/issue refs as code refs', () => {
    const refs = extractRefs('closes #45, relates to #7');
    expect(refs).toContainEqual({ ref: '#45', platform: 'code' });
    expect(refs).toContainEqual({ ref: '#7', platform: 'code' });
  });

  it('does not read a markdown heading as an issue ref', () => {
    expect(extractRefs('# 45 ways to fail\n## 7 more')).toEqual([]);
  });

  it('extracts slack archive URLs with the slack platform', () => {
    const refs = extractRefs('thread: https://align.slack.com/archives/C123/p456');
    expect(refs).toContainEqual({
      ref: 'https://align.slack.com/archives/C123/p456',
      platform: 'slack',
    });
  });

  it('extracts linear issue URLs with the linear platform', () => {
    const refs = extractRefs('see https://linear.app/align/issue/ALI-788/launch');
    expect(refs).toContainEqual({
      ref: 'https://linear.app/align/issue/ALI-788/launch',
      platform: 'linear',
    });
  });

  it('extracts jira browse URLs with the jira platform', () => {
    const refs = extractRefs('per https://acme.atlassian.net/browse/PAY-31');
    expect(refs).toContainEqual({
      ref: 'https://acme.atlassian.net/browse/PAY-31',
      platform: 'jira',
    });
  });

  it('extracts confluence wiki URLs with the confluence platform', () => {
    const refs = extractRefs('doc: https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Auth');
    expect(refs).toContainEqual({
      ref: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Auth',
      platform: 'confluence',
    });
  });

  it('extracts github pull/issue URLs with the github platform', () => {
    const refs = extractRefs('supersedes https://github.com/align/cli/pull/78');
    expect(refs).toContainEqual({
      ref: 'https://github.com/align/cli/pull/78',
      platform: 'github',
    });
  });

  // A ticket key inside a URL must not ALSO surface as a bare tracker ref - one
  // mention, one ref, or the gap prompt double-counts every linked ticket.
  it('does not double-count a ticket key that only appears inside a URL', () => {
    const refs = extractRefs('see https://acme.atlassian.net/browse/PAY-31 for details');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      ref: 'https://acme.atlassian.net/browse/PAY-31',
      platform: 'jira',
    });
  });

  it('dedupes repeated refs', () => {
    const refs = extractRefs('ALI-123 again ALI-123 and #45 then #45');
    expect(refs).toHaveLength(2);
  });

  it('returns empty for plain prose with no refs', () => {
    expect(extractRefs('Switch database from Postgres to CockroachDB')).toEqual([]);
  });

  // The commit-URL trailer formatCommitAsText appends is the decision's OWN address,
  // not a reference to something the graph cannot see.
  it('ignores commit URLs (a decision does not reference itself)', () => {
    expect(extractRefs('URL: https://github.com/align/cli/commit/abc123')).toEqual([]);
  });
});
