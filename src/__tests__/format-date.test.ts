import { describe, expect, it } from 'vitest';
import { formatWhen } from '../lib/format-date';

const NOW = Date.parse('2026-06-01T12:00:00Z');

describe('formatWhen', () => {
  it('returns empty for missing/invalid input', () => {
    expect(formatWhen(undefined, NOW)).toBe('');
    expect(formatWhen(null, NOW)).toBe('');
    expect(formatWhen('not a date', NOW)).toBe('');
  });

  it('uses relative phrasing for recent decisions', () => {
    expect(formatWhen('2026-06-01T09:00:00Z', NOW)).toBe('today');
    expect(formatWhen('2026-05-31T09:00:00Z', NOW)).toBe('yesterday');
    expect(formatWhen('2026-05-28T12:00:00Z', NOW)).toBe('4 days ago');
  });

  it('falls back to an absolute date once older than a month', () => {
    expect(formatWhen('2026-04-01T12:00:00Z', NOW)).toMatch(/Apr 2026/);
  });

  it('shows the date for future-dated timestamps', () => {
    expect(formatWhen('2026-07-01T12:00:00Z', NOW)).toMatch(/Jul 2026/);
  });
});
