import { describe, expect, it } from 'vitest';
import { isCutTitle, isHousekeepingTitle, isNonBehaviouralType, isReleaseOrBumpSubject, MECHANICAL_SUBJECT_PREFIXES, mechanicalSubjectRegex } from '../lib/commit-shape.js';

/**
 * Copilot on align-cli#240 (suppressed comment, landed after the merge): the predicate
 * regex was built by interpolating the prefix list straight into a pattern. Fine for the
 * eight plain words in it today, and silently wrong the day one carries a metacharacter.
 */
describe('mechanicalSubjectRegex', () => {
  it('treats a prefix literally even when it carries regex metacharacters', () => {
    const re = mechanicalSubjectRegex(['c++', 'wip']);
    expect(re.test('c++: rebuild the parser')).toBe(true);
    // Interpolated raw, `c++` reads as "one or more c" and this would match too.
    expect(re.test('ccc: three cs is not the c++ prefix')).toBe(false);
  });

  it('builds the predicate the real list uses: every member rejects, an unlisted one does not', () => {
    const re = mechanicalSubjectRegex(MECHANICAL_SUBJECT_PREFIXES);
    for (const prefix of MECHANICAL_SUBJECT_PREFIXES) expect(re.test(`${prefix}: something`), prefix).toBe(true);
    expect(re.test('feat: something')).toBe(false);
  });

  it('is anchored to the start and case-insensitive, as the original literal was', () => {
    const re = mechanicalSubjectRegex(['chore']);
    expect(re.test('CHORE: shout it')).toBe(true);
    expect(re.test('a chore: not at the start')).toBe(false);
  });
});

describe('isReleaseOrBumpSubject', () => {
  // Real fastify subjects. "Bumped v5.9.0" reached the first-run sample box because it was a PR
  // title and the PR path never applied the commit prefix list.
  it.each([
    'Bumped v5.9.0',
    'Bump v5.9.0',
    'Bumpedv v6.0.0-alpha.5',
    'Bumps lodash from 4.17.20 to 4.17.21',
    'Release v5.9.0',
    'Released 5.11.2 with the fixes below',
    'v5.9.0',
    '5.11.2',
    'Version 5.9.0',
    'chore(release): 5.9.0',
    'Update dependency lodash to v3',
    'Upgrade pino from 9 to 10',
    'fix: bump lodash from 4.17.20 to 4.17.21',
    'build(deps): bump tiny-lru from 10.4.1 to 11.0.1 (#4694)',
  ])('is housekeeping: %s', (subject) => {
    expect(isReleaseOrBumpSubject(subject)).toBe(true);
  });

  it.each([
    'fix: clamp error statusCode between 400 and 599 with 500 fallback (#7089)',
    'fix: do not trust forwarded host/proto when socket is missing',
    'build(deps): replace `proxy-addr` with `@fastify/proxy-addr` (#5913)',
    'feat: add support for version 2 of the schema',
    'Use release candidates only on the next branch',
    'fix: release the socket when the client aborts mid-request',
    // a scope named release is a topic, not a version
    'feat(release): publish with provenance attestations',
    'fix(release): pin npm to 10 so the publish job stops failing',
    // a bump that states why is a decision
    'fix: bump timeout from 5s to 30s because the upstream is slow',
    'feat: bump minimum Node to 20, drops 18',
    'fix: bump lodash to 4.17.21 (CVE-2021-23337)',
    'Update dependency lodash to v3 to avoid the prototype pollution',
    'Release 2FA support for admin accounts',
    'feat!: v6.0.0 drops Node 18',
    'Revert "Bump x from 1 to 2"',
    'feat: bump ajv-compiler (#3687)',
    'Update documentation for listening to 0.0.0.0 (#5988)',
    'docs: update all nodejs doc links to point to v14.x documentation (#3227)',
    'Update @types/node to 15.3.0 and fix type definition (#3076)',
  ])('is a decision, not housekeeping: %s', (subject) => {
    expect(isReleaseOrBumpSubject(subject)).toBe(false);
  });
});

describe('isHousekeepingTitle', () => {
  it('adds the docs/chore/ci shapes and [WIP markers to release and bump subjects', () => {
    expect(isHousekeepingTitle('Bumped v5.9.0')).toBe(true);
    expect(isHousekeepingTitle('docs: fix syntax errors in code examples (#7159)')).toBe(true);
    expect(isHousekeepingTitle('[WIP] feat: half finished retry policy work')).toBe(true);
    expect(isHousekeepingTitle('Merge pull request #25 from tnk/perf-connectors')).toBe(true);
  });
  it('treats a [Backport ...] copy as housekeeping: the decision is the original', () => {
    expect(isHousekeepingTitle('[Backport 5.x] docs(reply): reorganize Reply reference by properties and methods')).toBe(true);
    expect(isHousekeepingTitle('Backport the retry policy to the worker pool')).toBe(false);
  });
  it('leaves a real change alone, including one that starts with the word Merge', () => {
    expect(isHousekeepingTitle('fix: clamp error statusCode between 400 and 599 with 500 fallback (#7089)')).toBe(false);
    expect(isHousekeepingTitle('Merge the two queue workers into one process')).toBe(false);
  });
});

describe('isCutTitle', () => {
  // The graph stores a title as the first 80 characters, so one that fills all 80 may have lost
  // its tail: "...FastifyReplyContex" is not a thing to put in quotes.
  it('is true at the 80 character cut and above, false below it', () => {
    expect(isCutTitle('x'.repeat(80))).toBe(true);
    expect(isCutTitle('x'.repeat(81))).toBe(true);
    expect(isCutTitle('x'.repeat(79))).toBe(false);
  });
});

describe('isNonBehaviouralType', () => {
  it('matches docs, style, test, chore, ci, build, release and refactor types, scoped or not, any case, optional "!"', () => {
    for (const t of ['docs: x', 'docs(readme): x (#1)', 'Style(css): x', 'test: x', 'chore(deps): x', 'ci: x', 'build!: x', 'RELEASE: x', 'refactor: x', 'Refactor(core): x']) {
      expect(isNonBehaviouralType(t), t).toBe(true);
    }
  });

  it('does not match behavioural types, untyped subjects, or words that merely start with a type', () => {
    for (const t of ['fix: x', 'feat(core): x', 'perf: x', 'Add contributing.md', 'docs are great', 'testing: x', 'builder: x', 'refactoring the module']) {
      expect(isNonBehaviouralType(t), t).toBe(false);
    }
  });

  it('leaves isHousekeepingTitle exactly as it was: refactor and release-with-a-reason are still not housekeeping', () => {
    expect(isHousekeepingTitle('refactor: split error handling')).toBe(false);
    expect(isHousekeepingTitle('release: publish with provenance')).toBe(false);
    for (const t of ['docs: x', 'chore: x', 'style: x', 'test: x', 'build: x', 'ci: x', 'Merge pull request #3 from a/b', '[Backport v4] fix: x', 'Bump x from 1 to 2']) {
      expect(isHousekeepingTitle(t), t).toBe(true);
    }
  });
});
