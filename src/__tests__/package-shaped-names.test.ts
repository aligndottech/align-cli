/**
 * TEST LIST (policy: a wrongly KEPT bump is noise, a wrongly DROPPED decision is permanent loss)
 *  1. "dependency", "package" and "from <version>" are never evidence on their own: only a package-SHAPED name is
 *     (scoped, dotted, or a hyphenated lowercase name like xml-apis). A digit alone (python3) or a bare noun is not.
 *  2. Capture drops only Bump/chore prefixes and "Update dependency <package-shaped name> to v<version>".
 *  3. Render hides only package-shaped names, and isDependencyBumpSubject agrees with isReleaseOrBumpSubject.
 *  4. isGeneratedDecisionsFile needs the header alone on its line.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { isDependencyBumpSubject, isReleaseOrBumpSubject, isRenovateBump } from '../lib/commit-shape.js';
import { isDecisionCommit } from '../lib/git.js';
import { GENERATED_HEADER, isGeneratedDecisionsFile } from '../lib/decisions-context.js';

const KEEP_EVERYWHERE = [
  'Update dependency injection to v2',
  'Update dependency resolution to 2.0',
  'Upgrade dependency graph to v2',
  'Upgrade postgres from 14 to 16',
  'Update Postgres from 14 to 16',
  'Upgrade node from 18 to 20',
  'Update python3 to 3.12',
  'Update auth-service from v1 to v2',
  'Update db-schema from v1 to v2',
  'Update package manager to v2',
  'Update package layout to v2',
  'Update config from 1 to 2',
  'Update express from 4 to 5',
  'Update lodash to 4.17.21',
  'Switch to vite-plugin-react 4',
  'Migrate from express 4 to fastify 5',
];

const HIDDEN_IN_FILE = [
  'Update xml-apis to 1.0.b2',
  'Update @types/node to 20.1.0',
  'Upgrade jackson-databind to version 2.15',
  'Update vite-plugin-react to v4',
];

describe('only a package-shaped name is evidence of a bump', () => {
  it.each(KEEP_EVERYWHERE)('keeps %s at render and at capture', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(false);
    expect(isReleaseOrBumpSubject(subject)).toBe(false);
    expect(isReleaseOrBumpSubject(subject, { guessPackages: false })).toBe(false);
    expect(isRenovateBump(subject)).toBe(false);
    expect(isDecisionCommit(subject)).toBe(true);
  });

  it.each(HIDDEN_IN_FILE)('hides %s in the file, and both render predicates agree', (subject) => {
    expect(isDependencyBumpSubject(subject)).toBe(true);
    expect(isReleaseOrBumpSubject(subject)).toBe(true);
  });

  it.each(HIDDEN_IN_FILE)('never drops %s at capture (no "dependency" word)', (subject) => {
    expect(isDecisionCommit(subject)).toBe(true);
  });

  it.each([
    'Update dependency xml-apis to v1.0.1',
    'Update dependency @types/node to v20',
    'Update dependency jackson-databind to v2.15.0',
    'Update dependency vite-plugin-react to v4',
  ])('drops the exact renovate shape %s at capture', (subject) => {
    expect(isRenovateBump(subject)).toBe(true);
    expect(isDecisionCommit(subject)).toBe(false);
  });
});

describe('isGeneratedDecisionsFile', () => {
  it.each([
    [`${GENERATED_HEADER}\n\nbody`, true],
    [`${GENERATED_HEADER}\r\n\r\nbody`, true],
    [`${GENERATED_HEADER}`, true],
    [`﻿\n\n${GENERATED_HEADER}\nbody`, true],
    [`${GENERATED_HEADER} notes\nbody`, false],
    [`  ${GENERATED_HEADER}\nbody`, false],
    [`\t${GENERATED_HEADER}\nbody`, false],
    [`# Decisions\n${GENERATED_HEADER}\n`, false],
  ])('%j -> %s', (content, expected) => {
    expect(isGeneratedDecisionsFile(content)).toBe(expected);
  });
});
