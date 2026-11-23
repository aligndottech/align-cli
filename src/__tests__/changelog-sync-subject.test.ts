// "Sync CHANGELOG.md" is a release housekeeping commit, not a decision. It reached DECISIONS.md and
// `align import` because the capture filter only knew bump and release shapes. Two-sided on purpose:
// every drop below has a keep next to it that shares its words.
import { describe, expect, it } from 'vitest';
import { isHousekeepingTitle, isReleaseOrBumpSubject } from '../lib/commit-shape.js';
import { isDecisionCommit } from '../lib/git.js';

describe('changelog and readme sync subjects', () => {
  it.each([
    'Sync CHANGELOG.md',
    'Sync CHANGELOG.md (#123)',
    'sync changelog',
    'Update CHANGELOG',
    'Update changelog',
    'Update CHANGELOG.md.',
    'Update the changelog for v1.2.3',
    'Update changelog for 0.91.0',
    'Sync README.md',
    'Sync docs/CHANGELOG.md',
    'docs: sync CHANGELOG.md',
    'Regenerate CHANGELOG.md',
  ])('is housekeeping: %s', (subject) => {
    expect(isReleaseOrBumpSubject(subject)).toBe(true);
    expect(isHousekeepingTitle(subject)).toBe(true);
    expect(isDecisionCommit(subject)).toBe(false);
  });

  it.each([
    'Sync the cache across workers so reads never go stale',
    'Update changelog policy to require entries per PR',
    'Sync README.md with the new auth flow because the old one leaked tokens',
    'Update changelog format to Keep a Changelog, drops the custom layout',
    'Sync changelog generation into the release workflow',
    'Update README to say the CLI needs Node 22',
    'Sync CHANGELOG.md and README.md ownership to the docs team',
  ])('is kept: %s', (subject) => {
    expect(isReleaseOrBumpSubject(subject)).toBe(false);
    expect(isHousekeepingTitle(subject)).toBe(false);
    expect(isDecisionCommit(subject)).toBe(true);
  });
});
