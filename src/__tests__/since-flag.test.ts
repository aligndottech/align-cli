import { describe, expect, it } from 'vitest';
import { SINCE_HELP } from '../lib/since-flag.js';

describe('the --since help names the real default', () => {
  it('says 180 days, not 6m (which is 182)', () => {
    expect(SINCE_HELP).toContain('default 180 days');
    expect(SINCE_HELP).not.toMatch(/default 6m/);
  });
});
