/**
 * TEST LIST
 *  1. Given a subject that is only "<action> <package> [from <v>] to|with <version>", When judged, Then it is a
 *     mechanical dependency bump: "Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2",
 *     "Update dependency react to v18.3.1", "Upgrade jackson-databind to version 2.15", "Update lodash from 4.17.20 to 4.17.21".
 *  2. Given any prose after the version, or a sentence in place of a package, Then it is a decision: the seven
 *     subjects below plus three more.
 *  3. Given a mechanical shape that states a reason (a free-standing "allow", "security", "policy"), Then it is kept.
 *  4. Given "Bump ..." and "chore(deps): ..." subjects, Then isDecisionCommit still rejects them: main's
 *     MECHANICAL_SUBJECT_PREFIXES (bump, chore) did that already and this change neither widens nor narrows it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { isDependencyBumpSubject, isReleaseOrBumpSubject } from '../lib/commit-shape.js';
import { isDecisionCommit } from '../lib/git.js';
import { decisionShapedRows, selectForFile } from '../lib/context-from-graph.js';

const NEAR_MISSES = [
  'Update dependency policy: no snapshots',
  'Update dependencies policy: pin everything',
  'Replace dependency policy with a lockfile-only policy',
  'Replace dependencies with vendored copies so builds are offline',
  'Upgrade Postgres to 15.2 to get logical replication',
  'Upgrade Spring to 6.0 and require Java 17',
  'Upgrade Python 3.8 to 3.11 as 3.8 is EOL',
  'Update dependencies: we pin everything in the lockfile',
  'Upgrade the build image to Node 22 so CI matches production',
  'Replace dependency on moment with date-fns across the whole app',
];

describe('isDependencyBumpSubject', () => {
  it.each([
    'Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2',
    'Update dependency react to v18.3.1',
    'Upgrade jackson-databind to version 2.15',
    'Update lodash from 4.17.20 to 4.17.21',
    '(#12) Update dependency @types/node to 20.1.0 (#13)',
  ])('rejects the mechanical shape %s', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(true);
  });

  it.each(NEAR_MISSES)('keeps %s', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(false);
    expect(isDecisionCommit(subject)).toBe(true);
  });

  it.each([
    'Update dependency allow to v2',
    'Upgrade security to 2.0.1',
    'Replace dependency policy with policy 2.0',
  ])('keeps a mechanical shape that states a reason: %s', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(false);
  });
});

describe('isDecisionCommit and the bump family', () => {
  it.each([
    'Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2',
    'Update dependency react to v18.3.1',
    'Bump lodash from 4.17.20 to 4.17.21',
    'chore(deps): bump x from 1 to 2 in the lockfile',
  ])('rejects %s, so `align ask` never gets it', (subject) => {
    expect(isDecisionCommit(subject)).toBe(false);
  });
});

// Real decisions that the first bump shape swallowed: a config value, a runtime, or a tool swap is a choice.
const CONFIG_AND_SWAP_DECISIONS = [
  'Update timeout to 30',
  'update MAX_RETRIES to 5',
  'Update port to 8080',
  'Update retry_limit to 3 (#44)',
  'Upgrade python to 3.12',
  'Replace redis with valkey 8',
  'Replace jest with vitest 3',
];
const PACKAGE_BUMPS = [
  'Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2',
  'Update xml-apis to 1.0.b2',
  'Update lodash from 4 to 5',
  'Update dependency @types/node to 20.1.0',
  'Upgrade jackson-databind to version 2.15',
];

// Bare lowercase nouns that are real choices. A word list of these is whack-a-mole, so none of them is a package.
const BARE_NOUN_DECISIONS = [
  'Update docs to v2', 'Update config to v2', 'Update schema to v3', 'Update protocol to v2', 'Update auth to v2',
  'Update api to v2', 'Update billing to v2', 'Update cache to v2', 'Update ci to v4', 'Update auth to 2.0',
  'Update http to 2.0', 'Update openapi to 3.1', 'Update python:3.11 to 3.12',
];

describe('a bare noun moving to a version is a decision at capture and in the file', () => {
  it.each(BARE_NOUN_DECISIONS)('keeps %s everywhere', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(false);
    expect(isReleaseOrBumpSubject(subject)).toBe(false);
  });

  it.each(BARE_NOUN_DECISIONS.filter((s) => s.length >= 20))('keeps %s at capture (isDecisionCommit)', (subject) => {
    expect(isDecisionCommit(subject)).toBe(true);
  });

  it('capture never guesses a package: Update lodash from 4 to 5 is housekeeping to display surfaces only', () => {
    expect(isReleaseOrBumpSubject('Update lodash from 4 to 5')).toBe(true);
    expect(isReleaseOrBumpSubject('Update lodash from 4 to 5', { guessPackages: false })).toBe(false);
  });

  it('agrees between the file rule and the capture rule on an image tag', () => {
    expect(isDependencyBumpSubject('Update python:3.11 to 3.12')).toBe(isReleaseOrBumpSubject('Update python:3.11 to 3.12'));
  });

  it.each(['Update dependency docs to v2', 'Update package config to 2.0', 'Update @types/node to 20.1.0', 'Update jackson-databind to 2.15'])('hides %s in the file when it names a package', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(true);
  });
});

describe('a config value, a runtime or a tool swap is a decision, not a bump', () => {
  it.each(CONFIG_AND_SWAP_DECISIONS)('keeps %s', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(false);
  });

  it.each(CONFIG_AND_SWAP_DECISIONS.filter((s) => s.length >= 20))('keeps %s at capture (isDecisionCommit)', (subject) => {
    expect(isDecisionCommit(subject)).toBe(true);
  });

  it.each(PACKAGE_BUMPS)('hides the package-shaped %s in the file', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(true);
  });

  it.each(PACKAGE_BUMPS.filter((s) => !/dependency/i.test(s)))('never drops %s at capture: a package guess is not an unambiguous rule', (subject) => {
    expect(isDecisionCommit(subject)).toBe(true);
  });

  it('keeps a decision-shaped package swap in the rows, and selectForFile hides it from the file only', () => {
    const rows = [{ title: 'Replace xml-apis with xml-apis 1.0.b2', platform: 'git' }] as never[];
    expect(decisionShapedRows(rows)).toHaveLength(1);
    expect(selectForFile(rows, 30).decisions).toEqual([]);
  });

  it.each(PACKAGE_BUMPS.filter((s) => /dependency/i.test(s)))('still drops the renovate-shaped %s at capture', (subject) => {
    expect(isDecisionCommit(subject)).toBe(false);
  });

  it('keeps a tool swap and drops a package bump when choosing rows for the file', () => {
    const git = (title: string) => ({ title, platform: 'git' });
    const kept = decisionShapedRows([
      git('Replace redis with valkey 8'),
      git('Replace jest with vitest 3'),
      git('Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2'),
    ]).map((r) => r.title);
    expect(kept).toEqual(['Replace redis with valkey 8', 'Replace jest with vitest 3']);
  });

  it('leaves "Bump ..." to the existing prefix rule', () => {
    expect(isDecisionCommit('Bump lodash to 4.17.21 in the lockfile')).toBe(false);
  });
});
