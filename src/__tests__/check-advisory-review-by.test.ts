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
  describe('review_by inside a field-separated line (ledger style)', () => {
    const COLLIN = 'Control: id: D-001 \u00b7 status: test \u00b7 review_by: 2026-06-01 \u00b7 modified: 2026-10-27';
    it("flags Collin's ledger line (middle dot separators) once the date has passed", () => {
      expect(line(COLLIN)).toContain(FLAG);
    });
    it('flags a middle-dot line written with the "Review by" spelling at the end', () => {
      expect(line('Control: id: D-002 \u00b7 status: stable \u00b7 Review by: 2026-06-01')).toContain(FLAG);
    });
    it('flags a pipe-separated line', () => {
      expect(line('Control: id: D-003 | status: experimental | review-by: 2026-06-01 | modified: 2026-10-27')).toContain(FLAG);
    });
    it('says nothing for a future inline date', () => {
      expect(line(COLLIN.replace('2026-06-01', '2027-04-27'))).not.toContain('review-by');
    });
    it('keeps latest wins across inline and start-of-line dates', () => {
      expect(line(`${COLLIN}\nReview-by: 2027-06-01`)).not.toContain('review-by');
      expect(line(`${COLLIN}\nReview-by: 2026-01-01`)).toContain(FLAG);
    });
    it('ignores an unparseable inline date', () => {
      expect(line(COLLIN.replace('2026-06-01', '2026-13-45'))).not.toContain('review-by');
    });
    it('does not read "review date" inline', () => {
      expect(line(COLLIN.replace('review_by', 'review date'))).not.toContain('review-by');
    });
    it('does not match prose that merely contains "review by" after a separator', () => {
      expect(line('We chose A | B and want a review by: 2026-06-01 someday')).not.toContain('review-by');
      expect(line('Notes \u00b7 needs a review by 2026-06-01')).not.toContain('review-by');
    });
    it('a retired entry is not overdue', () => {
      expect(line(COLLIN.replace('status: test', 'status: retired'))).not.toContain('review-by');
      expect(line('Control: id: D-004 | status: RETIRED | review_by: 2026-06-01')).not.toContain('review-by');
    });
    it('retired only counts within the same line: another line stays flagged', () => {
      expect(line(`${COLLIN.replace('status: test', 'status: retired')}\n${COLLIN.replace('D-001', 'D-005')}`)).toContain(FLAG);
    });
    it('a plain "status: retired" line does not suppress a separate start-of-line date', () => {
      expect(line('status: retired\nReview-by: 2026-06-01')).toContain(FLAG);
    });
  });
});
