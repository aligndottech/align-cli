import { describe, expect, it } from 'vitest';
import { isoDay } from '../lib/decision-render.js';

/** SQLite writes created_at as "YYYY-MM-DD HH:MM:SS" in UTC, with a space and no zone. */
describe('isoDay reads a space-separated timestamp as UTC', () => {
  it('keeps the UTC day in a timezone behind UTC', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(new Date('2026-11-13 23:30:00').getUTCDate()).toBe(14); // positive control: local parse shifts the day
      expect(isoDay('2026-11-13 23:30:00')).toBe('2026-11-13');
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it('keeps the UTC day in a timezone ahead of UTC', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      expect(isoDay('2026-11-13 00:30:00')).toBe('2026-11-13');
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });
});
