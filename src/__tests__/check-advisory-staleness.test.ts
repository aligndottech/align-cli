import { describe, expect, it } from 'vitest';
import { buildRelatedOutput } from '../commands/check.js';

/**
 * dev.to feedback: "a decision with no date, or one gone stale, gets argued again" and "does it show
 * who made it". The per-decision line now says who (only when the source recorded it) and when a
 * decision is old or undated. `now` is injected so the 12-month boundary is exact.
 */
const NOW = Date.UTC(2026, 10, 14, 0, 0, 0); // 2026-11-14
const claude = { pre: true, format: 'claude', blockOnCritical: false, now: NOW } as const;
const ctx = (out: unknown): string => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
const show = (d: Parameters<typeof buildRelatedOutput>[0]): string => ctx(buildRelatedOutput(d, claude));
const line = (d: Parameters<typeof buildRelatedOutput>[0]): string => show(d).split('\n').find((l) => l.startsWith('- ')) as string;
const CUE = 'confirm it still holds';

const commitSummary = (author: string): string =>
  `Use SQS for retries\n\nWe pick SQS because Redis lost jobs.\n\nAuthor: ${author}\n\nDate: 2024-05-14T00:00:00Z\n\nFiles changed:\nsrc/q.ts\n\nURL: https://github.com/o/r/commit/abc1234`;
const commitUrl = 'https://github.com/o/r/commit/abc1234def';

describe('staleness cue', () => {
  it('says nothing at exactly 12 months', () => {
    expect(line([{ id: 'a', title: 'Rule', decided_at: '2025-11-14T00:00:00Z' }])).not.toContain(CUE);
  });
  it('flags 12 months plus one day, with the whole months elapsed', () => {
    expect(line([{ id: 'a', title: 'Rule', decided_at: '2025-11-13T00:00:00Z' }])).toContain('(12 months old: confirm it still holds)');
  });
  it('flags a much older decision with its own month count', () => {
    expect(line([{ id: 'b', title: 'Rule', decided_at: '2024-05-14T00:00:00Z' }])).toContain('(30 months old: confirm it still holds)');
  });
  it('says nothing for a recent decision', () => {
    expect(line([{ id: 'c', title: 'Rule', decided_at: '2026-09-14T00:00:00Z' }])).not.toContain(CUE);
  });
  it('flags an import-date-only decision as undated', () => {
    const l = line([{ id: 'd', title: 'Rule', created_at: '2026-11-13 10:00:00' }]);
    expect(l).toContain('[imported 2026-11-13]');
    expect(l).toContain('(no decision date: confirm it still holds)');
  });
  it('flags a decision with no dates at all as undated', () => {
    expect(line([{ id: 'e', title: 'Bare' }])).toContain('(no decision date: confirm it still holds)');
  });
  it('flags an unparseable decided_at as undated', () => {
    expect(line([{ id: 'f', title: 'Bare', decided_at: 'soon' }])).toContain('(no decision date: confirm it still holds)');
  });
});

describe('who made it', () => {
  it('shows the commit author and strips the email', () => {
    const l = line([{ id: 'g', title: 'Use SQS for retries', url: commitUrl, summary: commitSummary('Ana Ruiz <ana@example.com>'), decided_at: '2024-05-14T00:00:00Z' }]);
    expect(l).toContain(' by Ana Ruiz');
    expect(l).not.toContain('ana@example.com');
  });
  it('shows a second author as written', () => {
    expect(line([{ id: 'h', title: 'Use SQS for retries', url: commitUrl, summary: commitSummary('Bo Lee'), decided_at: '2026-09-14T00:00:00Z' }])).toContain(' by Bo Lee');
  });
  it('prints no "by" when the decision records no author', () => {
    expect(line([{ id: 'i', title: 'ADR-3', summary: 'We chose Postgres for the graph.', decided_at: '2026-09-14T00:00:00Z' }])).not.toContain(' by ');
  });
  it('prints no "by" for a non-commit source even if the text has an Author line', () => {
    expect(line([{ id: 'j', title: 'Doc', url: 'https://x.test/doc', summary: 'Intro\n\nAuthor: Cy\n\nDate: 2026-01-01', decided_at: '2026-09-14T00:00:00Z' }])).not.toContain(' by ');
  });
  it('puts author before the staleness cue', () => {
    const l = line([{ id: 'k', title: 'Use SQS for retries', url: commitUrl, summary: commitSummary('Ana Ruiz <ana@example.com>'), decided_at: '2024-05-14T00:00:00Z' }]);
    expect(l).toMatch(/ by Ana Ruiz \(30 months old: confirm it still holds\)$/);
  });
});
