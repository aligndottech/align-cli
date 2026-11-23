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

import { isDependencyBumpSubject } from '../lib/commit-shape.js';
import { isDecisionCommit } from '../lib/git.js';

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
