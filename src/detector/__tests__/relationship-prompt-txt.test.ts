/**
 * relationship-prompt.v1.txt is the shared v1 base prompt as plain text, the bytes the Phase A
 * harness and the brain vendor. It is exactly what the CLI's v1 detector sends as its system
 * prompt (buildV1SystemPrompt, composed from relationship-prompt.v1.json), so a score measured
 * on the file describes the CLI. It carries none of the hosted-only extensions.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildV1SystemPrompt } from '../relationship-prompt.js';

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'relationship-prompt.v1.txt'), 'utf8');

describe('relationship-prompt.v1.txt', () => {
  it('positive control: holds the agreement check, the incompatible verdict and the replaced field', () => {
    expect(text).toContain('AGREEMENT CHECK');
    expect(text).toContain('"type": "incompatible|');
    expect(text).toContain('"replaced": "new" | "existing" | null');
  });

  it('is byte for byte what the v1 detector sends', () => {
    expect(text).toBe(buildV1SystemPrompt());
  });

  it.each([
    'SIBLING', 'siblings', 'missing_evidence', 'MISSING EVIDENCE', 'REDACTED', 'ambiguity', 'Ambiguity',
    'SCOPE AWARENESS', 'ORG-LEVEL', 'org_level', 'EXCEPTED BY', 'SUPERSEDED BY', 'Altitude', 'Team/Project', '"existing": {',
  ])('carries no hosted-only extension marker: %s', (marker) => {
    expect(text).not.toContain(marker);
  });
});
