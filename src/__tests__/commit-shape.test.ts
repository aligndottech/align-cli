import { describe, expect, it } from 'vitest';
import { isCutTitle, isHousekeepingTitle, isReleaseOrBumpSubject, MECHANICAL_SUBJECT_PREFIXES, mechanicalSubjectRegex } from '../lib/commit-shape.js';

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
    'chore: release 5.9.0',
    'v5.9.0',
    '5.11.2',
    'Version 5.9.0',
    'chore(release): 5.9.0',
    'build(deps): bump tiny-lru from 10.4.1 to 11.0.1 (#4694)',
    'feat: bump ajv-compiler (#3687)',
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
