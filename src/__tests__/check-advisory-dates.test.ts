import { describe, expect, it } from 'vitest';
import { buildRelatedOutput, EXCERPT_BUDGET_CHARS, EXCERPT_TOTAL_BUDGET_CHARS } from '../commands/check.js';

/**
 * A user report: "the edit hook's context has no dates, and trims each item just
 * before the sentence that matters." Each item now says when it was decided, and a cut keeps
 * whole sentences.
 */
const claude = { pre: true, format: 'claude', blockOnCritical: false } as const;
const ctx = (out: unknown): string => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
const show = (decisions: Parameters<typeof buildRelatedOutput>[0], wrote: Parameters<typeof buildRelatedOutput>[2] = []): string => ctx(buildRelatedOutput(decisions, claude, wrote));

describe('each item carries its date', () => {
  it('shows decided_at as a day, not the import time', () => {
    // The two differ on purpose: only decided_at may reach the agent.
    const out = show([{ id: 'a', title: 'Use Redis', decided_at: '2026-09-14T08:30:00Z', created_at: '2026-11-13 10:00:00' }]);
    expect(out).toContain('- [2026-09-14] Use Redis');
    expect(out).not.toContain('2026-11-13');
  });

  it('a second decision shows its own date', () => {
    expect(show([{ id: 'b', title: 'Use SQS', decided_at: '2026-03-02T00:00:00Z' }])).toContain('- [2026-03-02] Use SQS');
  });

  it('marks the fallback to the import date, since that is not when it was decided', () => {
    const out = show([{ id: 'c', title: 'Use Kafka', created_at: '2026-11-13 10:00:00' }]);
    expect(out).toContain('- [imported 2026-11-13] Use Kafka');
  });

  it('shows no bracket when neither date is usable', () => {
    const out = show([{ id: 'd', title: 'Bare', decided_at: 'soon', created_at: 'later' }]);
    expect(out).toContain('- Bare\n');
  });

  it('dates the blame decisions too', () => {
    expect(show([], [{ id: 'w', title: 'Cache sessions', decided_at: '2026-05-05T00:00:00Z' }])).toContain('- [2026-05-05] Cache sessions');
  });

  it('puts the replaced note after the title, the date before it', () => {
    const out = show([{ id: 'o', title: 'Use Redux', decided_at: '2025-01-01T00:00:00Z', status: 'superseded', successor: { id: 'n', title: 'Use the store' } }]);
    expect(out).toContain('- [2025-01-01] Use Redux (replaced by: Use the store)');
  });
});

describe('newer items are told apart from older ones', () => {
  it('lists the newest decision first, whatever order retrieval returned', () => {
    const out = show([
      { id: 'old', title: 'Old rule', decided_at: '2025-01-01T00:00:00Z' },
      { id: 'new', title: 'New rule', decided_at: '2026-06-01T00:00:00Z' },
    ]);
    expect(out.indexOf('New rule')).toBeLessThan(out.indexOf('Old rule'));
  });

  it('keeps retrieval order between undated items and puts them after dated ones', () => {
    const out = show([
      { id: 'u1', title: 'Undated one' },
      { id: 'dated', title: 'Dated', decided_at: '2020-01-01T00:00:00Z' },
      { id: 'u2', title: 'Undated two' },
    ]);
    expect(out.indexOf('Dated')).toBeLessThan(out.indexOf('Undated one'));
    expect(out.indexOf('Undated one')).toBeLessThan(out.indexOf('Undated two'));
  });
});

describe('a cut keeps whole sentences', () => {
  const key = 'Never cache the session in process memory.';
  const filler = 'We measured the pods under load and the resident set grew without bound across every deploy window.';

  it('text within the budget is untouched, byte for byte', () => {
    const text = 'Short first sentence. Short second sentence!';
    expect(show([{ id: 's', title: 'Short', summary: text }])).toContain(`- Short\n  ${text}\n`);
  });

  it('drops trailing sentences whole and marks the cut', () => {
    const text = `${key} ${filler} ${filler}`;
    const out = show([{ id: 'l', title: 'Long', summary: text }]);
    const line = out.split('\n').find((l) => l.startsWith('  Never')) as string;
    expect(line.trim()).toBe(`${key} ${filler}...`);
    expect(line.trim().length).toBeLessThanOrEqual(EXCERPT_BUDGET_CHARS);
  });

  it('never ends mid-sentence when a whole sentence fits', () => {
    const text = `${key} ${filler} Then a final sentence that does not fit in what is left of the budget at all, really.`;
    const line = show([{ id: 'm', title: 'Mid', summary: text }]).split('\n').find((l) => l.startsWith('  Never')) as string;
    expect(line.trim()).toMatch(/[.!?]\.\.\.$/);
  });

  it('a first sentence longer than the budget still falls back to a word cut', () => {
    const one = `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')}. Second sentence.`;
    const line = show([{ id: 'w', title: 'One', summary: one }]).split('\n').find((l) => l.startsWith('  word')) as string;
    expect(line.trim().endsWith('...')).toBe(true);
    expect(line.trim().length).toBeLessThanOrEqual(EXCERPT_BUDGET_CHARS);
  });

  it('does not split a sentence at a dotted path or a version number', () => {
    const text = `Keep state in src/store.ts and bump to v1.2.3 only. ${filler} ${filler} ${filler}`;
    const line = show([{ id: 'p', title: 'Path', summary: text }]).split('\n').find((l) => l.startsWith('  Keep')) as string;
    expect(line.trim().startsWith('Keep state in src/store.ts and bump to v1.2.3 only.')).toBe(true);
  });

  it('the shared total still bounds the whole block', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, title: `Decision ${i}`, summary: `${key} ${filler} ${filler}` }));
    const out = show(many);
    const chars = out.split('\n').filter((l) => l.startsWith('  Never')).reduce((n, l) => n + l.trim().length, 0);
    expect(chars).toBeLessThanOrEqual(EXCERPT_TOTAL_BUDGET_CHARS);
  });
});
