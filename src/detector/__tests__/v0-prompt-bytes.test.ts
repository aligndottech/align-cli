/**
 * The v0 detector's prompt bytes, pinned BEFORE any v1 code landed (P3 of the shared detector plan).
 *
 * `ALIGN_DETECTOR` unset or `v0` must send exactly what the CLI sent before v1 existed. These
 * hashes were taken from the classifier at 4ad1679 (P1, no behaviour change). If one moves, the
 * default detector changed: that needs its own PR and a CHANGELOG line, never a hash refresh here.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildUserPrompt, V0_SYSTEM_PROMPT } from '../../lib/local-relationship-classifier.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('v0 prompt bytes are unchanged', () => {
  it('system prompt: positive control, then the pinned hash', () => {
    expect(V0_SYSTEM_PROMPT).toContain('"conflicts_with" or "contradicts" ONLY');
    expect(sha256(V0_SYSTEM_PROMPT)).toBe('4d73c4a89e23710c9f5fd5f779620a1981bd87e32eedf01c3f547c1d7b75d49c');
  });

  it('user prompt for a fixed pair and budget', () => {
    const prompt = buildUserPrompt(
      { title: 'Use Postgres for queues', summary: 'We keep jobs in a Postgres table.' },
      { title: 'Move queues to SQS', summary: 'Jobs move to SQS next quarter.' },
      8192,
      256,
    );
    expect(prompt).toContain('Decision B: Move queues to SQS.');
    expect(sha256(prompt)).toBe('6530220eb9a8dbf28d969471dcf6669ba12e74dc94d86b31e64877766b5ce1eb');
  });
});
