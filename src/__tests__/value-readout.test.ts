import { describe, expect, it } from 'vitest';
import { renderValueReadout } from '../lib/value-rollup.js';
import type { ValueRollup } from '../lib/value-rollup.js';

const base: ValueRollup = {
  decisions: 142,
  conflictsCaught: 6,
  duplicates: 9,
  supersessions: 4,
  reuseRate: 0.72,
  healthGrade: 'B',
};

// strip ANSI so assertions aren't colour-dependent
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

describe('renderValueReadout (ALI-215)', () => {
  it('names value units, not "connections"', () => {
    const out = plain(renderValueReadout(base, { mode: 'cloud' }));
    expect(out).toMatch(/conflicts caught/i);
    expect(out).toMatch(/duplicates/i);
    expect(out).toMatch(/supersed/i);
    expect(out).not.toMatch(/connections/i);
  });

  it('renders the reuse rate as a percentage when present', () => {
    const out = plain(renderValueReadout(base, { mode: 'cloud' }));
    expect(out).toMatch(/72%/);
  });

  it('shows n/a (not "null%") when reuse rate is null', () => {
    const out = plain(renderValueReadout({ ...base, reuseRate: null }, { mode: 'cloud' }));
    expect(out).toMatch(/reuse[^\n]*n\/a/i);
    expect(out).not.toMatch(/null/i);
  });

  it('keeps the value labels on an empty graph (no vanity collapse)', () => {
    const empty: ValueRollup = { decisions: 3, conflictsCaught: 0, duplicates: 0, supersessions: 0, reuseRate: null, healthGrade: null };
    const out = plain(renderValueReadout(empty, { mode: 'cloud' }));
    expect(out).toMatch(/conflicts caught/i);
    expect(out).toMatch(/0/);
  });

  it('labels the local subset (reuse/health need cloud)', () => {
    const out = plain(renderValueReadout({ ...base, reuseRate: null, healthGrade: null }, { mode: 'local' }));
    expect(out).toMatch(/cloud/i); // states the missing metrics need cloud
  });

  it('appends the earned upgrade nudge when there is real value', () => {
    const out = plain(renderValueReadout(base, { mode: 'cloud' }));
    expect(out).toMatch(/pricing|team/i);
  });

  it('does not nudge on an empty graph (nudge must be earned)', () => {
    const empty: ValueRollup = { decisions: 0, conflictsCaught: 0, duplicates: 0, supersessions: 0, reuseRate: null, healthGrade: null };
    const out = plain(renderValueReadout(empty, { mode: 'cloud' }));
    expect(out).not.toMatch(/pricing/i);
  });
});
