/**
 * TEST LIST
 *  1. Given "Replace dependency a:b with a:b 1.0", When judged, Then it is a dependency bump.
 *  2. Given "Update dependency lodash to v4" and "Upgrade the xml parser to 2.3.1", Then both are bumps.
 *  3. Given "chore(deps): ..." Then it is a bump.
 *  4. Given near misses ("Use pnpm instead of npm", "Replace Redis with Valkey", 
 *     with a registry"), Then they are kept.
 *  5. Given a bump subject, isDecisionCommit rejects it, so `align ask` never gets it; a near miss is accepted.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { isDependencyBumpSubject } from '../lib/commit-shape.js';
import { isDecisionCommit } from '../lib/git.js';

describe('isDependencyBumpSubject', () => {
  it.each([
    'Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2',
    '(#12) Replace dependencies org.foo:bar with org.foo:bar 2.0',
    'Update dependency lodash to v4',
    'Update dependencies for the build',
    'Upgrade the xml parser to 2.3.1',
    'Upgrade jackson-databind to version 2.15',
    'chore(deps): move the parser along',
    'Bump guava from 30 to 31',
  ])('treats %s as housekeeping', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(true);
  });

  it.each([
    'Use pnpm instead of npm for installs',
    'Replace Redis with Valkey',
    'Upgrade path: we always migrate in two steps',
    'Update the retry policy to never exceed five attempts',
  ])('keeps %s', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(false);
  });
});

describe('isDecisionCommit and the bump family', () => {
  it('rejects a dependency replacement, so it never becomes a decision', () => {
    expect(isDecisionCommit('Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2')).toBe(false);
    expect(isDecisionCommit('Upgrade jackson-databind to version 2.15')).toBe(false);
  });

  it('accepts the near miss', () => {
    expect(isDecisionCommit('Use pnpm instead of npm for installs')).toBe(true);
  });
});
