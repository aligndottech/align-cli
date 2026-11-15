import { describe, expect, it } from 'vitest';
import { buildRelatedOutput } from '../commands/check.js';

/**
 * Andon-style review-by dates: a date someone chose beats age as a signal. The date is read from the
 * stored summary at check time (no schema column), so it works for already-imported ADRs.
 */
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0); // 2026-11-15
const claude = { pre: true, format: 'claude', blockOnCritical: false, now: NOW } as const;
const ctx = (out: unknown): string => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
const line = (summary: string, decided_at = '2026-10-01T00:00:00Z'): string =>
  ctx(buildRelatedOutput([{ id: 'a', title: 'Use SQS', decided_at, summary }], claude)).split('\n').find((l) => l.startsWith('- ')) as string;
const FLAG = 'review-by date 2026-06-01 has passed';

describe('review-by flag', () => {
  it('does not treat "Review date:" as a deadline (it records when a review happened)', () => {
    expect(line('Review date: 2026-06-01\nBody text.')).not.toContain('review-by');
  });
  it('uses the latest of several review-by dates: past then future is not flagged', () => {
    expect(line('Review-by: 2026-06-01\nReview-by: 2027-06-01\nBody.')).not.toContain('review-by');
  });
  it('uses the latest of several review-by dates: future then past is not flagged either', () => {
    expect(line('Review-by: 2027-06-01\nReview-by: 2026-06-01\nBody.')).not.toContain('review-by');
  });
  it('flags when the latest of several dates has passed', () => {
    expect(line('Review-by: 2026-01-01\nReview-by: 2026-06-01\nBody.')).toContain(FLAG);
  });
  it.each([
    ['Review-by: 2026-06-01'], ['Review by: 2026-06-01'],
    ['---\nreview_by: 2026-06-01\n---'], ['---\nreview-by: "2026-06-01"\n---'],
  ])('flags a passed date written as %j', (stated) => {
    expect(line(`# Use SQS\n\n${stated}\n\nWe use SQS because Redis lost jobs.`)).toContain(FLAG);
  });
  it('flags a second passed date too', () => {
    expect(line('Status: accepted\nReview-by: 2026-01-15\nBody text.')).toContain('review-by date 2026-01-15 has passed');
  });
  it('says nothing for a future date', () => {
    expect(line('Review-by: 2027-06-01\nBody text.')).not.toContain('review-by');
  });
  it('says nothing on the review day itself', () => {
    expect(line('Review-by: 2026-11-15\nBody text.')).not.toContain('review-by');
  });
  it('says nothing for an undated doc, and keeps the old staleness cue', () => {
    const l = line('Just a body.', '2024-01-01T00:00:00Z');
    expect(l).not.toContain('review-by');
    expect(l).toContain('confirm it still holds');
  });
  it('ignores a date that is not on a review-by line', () => {
    expect(line('We will talk about the review by 2026-06-01 eventually.\nDate: 2026-06-01')).not.toContain('review-by');
  });
  it('ignores an unreal date', () => {
    expect(line('Review-by: 2026-13-45')).not.toContain('review-by');
  });
});
