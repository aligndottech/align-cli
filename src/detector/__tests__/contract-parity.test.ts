/**
 * CLI-only checks on the relationship contract. The vendored half (vectors, parser rules) is in
 * relationship-contract.test.ts; this file stays here because it reads the installed
 * @aligndottech/connector-core and the lock that align-stack's sync script verifies.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISION_RELATIONSHIPS, DETERMINISTIC_TEMPERATURE } from '@aligndottech/connector-core';
import { describe, expect, it } from 'vitest';
import { RELATIONSHIP_CONTRACT } from '../relationship-contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const detectorDir = join(here, '..');
const lock = JSON.parse(readFileSync(join(detectorDir, 'contract.lock.json'), 'utf8')) as {
  revision: string;
  files: Record<string, string>;
};
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('offers.legacyV0 is the offer list the CLI ships today', () => {
  it('equals connector-core DECISION_RELATIONSHIPS, same values in the same order', () => {
    expect(DECISION_RELATIONSHIPS.length).toBe(10);
    expect(RELATIONSHIP_CONTRACT.offers.legacyV0).toEqual([...DECISION_RELATIONSHIPS]);
  });

  it('is still what the CLI classifier offers (the classifier imports the same package list)', () => {
    const source = readFileSync(join(detectorDir, '..', 'lib', 'local-relationship-classifier.ts'), 'utf8');
    expect(source).toContain('export const RELATIONSHIP_TYPES = DECISION_RELATIONSHIPS;');
  });

  it('temperature equals the connector-core determinism constant', () => {
    expect(RELATIONSHIP_CONTRACT.temperature).toBe(DETERMINISTIC_TEMPERATURE);
  });
});

describe('contract.lock.json pins every vendored file', () => {
  it('lists the four files align-stack vendors, with a revision', () => {
    expect(Object.keys(lock.files).sort()).toEqual([
      '__tests__/relationship-contract.test.ts',
      'parse-vectors.json',
      'relationship-contract.ts',
      'relationship-contract.v1.json',
    ]);
  });

  it.each(['relationship-contract.v1.json', 'parse-vectors.json', 'relationship-contract.ts', '__tests__/relationship-contract.test.ts'])(
    '%s matches its pinned sha256',
    (file) => {
      expect(sha256(join(detectorDir, file)), `${file} changed: bump "revision" in relationship-contract.v1.json, then update contract.lock.json (shasum -a 256 <file>)`).toBe(lock.files[file]);
    },
  );

  it('carries the same revision as the contract file, so editing one without the other fails', () => {
    expect(lock.revision).toBe(RELATIONSHIP_CONTRACT.revision);
  });
});
