import { describe, expect, it } from 'vitest';
import { formatLoginExpiry } from '../lib/login-expiry.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('formatLoginExpiry', () => {
  it('shows the date and whole days left for a future expiry', () => {
    expect(formatLoginExpiry('2027-01-19T12:00:00Z', NOW)).toBe('Login expires: 2027-01-19 (in 90 days)');
    expect(formatLoginExpiry(at(30 * DAY), NOW)).toBe('Login expires: 2026-11-20 (in 30 days)');
  });

  it('rounds partial days down and says "in 1 day" in the singular', () => {
    expect(formatLoginExpiry(at(DAY + 3_600_000), NOW)).toBe('Login expires: 2026-10-22 (in 1 day)');
  });

  it('says "today" when under a day is left', () => {
    expect(formatLoginExpiry(at(3 * 3_600_000), NOW)).toBe('Login expires: 2026-10-21 (today)');
  });

  it('tells the user to log in again once the date has passed', () => {
    expect(formatLoginExpiry(at(-DAY), NOW)).toBe('Login expired: 2026-10-20. Run: align login');
    expect(formatLoginExpiry(at(-1), NOW)).toBe('Login expired: 2026-10-21. Run: align login');
  });

  it('prints nothing for null, absent, or an unparseable value', () => {
    expect(formatLoginExpiry(null, NOW)).toBeNull();
    expect(formatLoginExpiry(undefined, NOW)).toBeNull();
    expect(formatLoginExpiry('not-a-date', NOW)).toBeNull();
  });
});
