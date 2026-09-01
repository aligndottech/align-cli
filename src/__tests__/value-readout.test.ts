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
  gaps: [],
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
    const empty: ValueRollup = { decisions: 3, conflictsCaught: 0, duplicates: 0, supersessions: 0, reuseRate: null, healthGrade: null, gaps: [] };
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
    const empty: ValueRollup = { decisions: 0, conflictsCaught: 0, duplicates: 0, supersessions: 0, reuseRate: null, healthGrade: null, gaps: [] };
    const out = plain(renderValueReadout(empty, { mode: 'cloud' }));
    expect(out).not.toMatch(/pricing/i);
  });
});

describe('renderValueReadout offline zero counters (ALI-794 component 4)', () => {
  // Nothing offline writes a duplicate, supersession or similarity link on a first
  // run, so all three are structurally zero. Printed as "0 duplicates found" beside a
  // real decision count they read as a broken dashboard to someone who has been using
  // the tool for ninety seconds. They are HIDDEN AT ZERO, not deleted: the counters
  // still run (localValueRollup keeps counting the real relations, ALI-503's positive
  // control), so the moment one is genuinely non-zero it appears.
  const offlineEmpty: ValueRollup = {
    decisions: 47, conflictsCaught: 0, similarDecisions: 0, duplicates: 0,
    supersessions: 0, reuseRate: null, healthGrade: null,
  };

  it('hides the three permanently-zero counters in local mode', () => {
    const out = plain(renderValueReadout(offlineEmpty, { mode: 'local' }));
    expect(out).toMatch(/47 decisions/);
    expect(out).not.toMatch(/duplicates/i);
    expect(out).not.toMatch(/supersed/i);
    expect(out).not.toMatch(/similar/i);
  });

  it('shows the duplicates line the moment one is real', () => {
    // The positive control. Without it, "hide at zero" and "delete the counter" are
    // the same green, and the second one silently loses the ability to ever report.
    const out = plain(renderValueReadout({ ...offlineEmpty, duplicates: 2 }, { mode: 'local' }));
    expect(out).toMatch(/2 duplicates/i);
  });

  it('shows the supersession line the moment one is real', () => {
    const out = plain(renderValueReadout({ ...offlineEmpty, supersessions: 1 }, { mode: 'local' }));
    expect(out).toMatch(/1 decision superseded|1 decisions superseded/i);
  });

  it('shows the similar-decisions headline the moment one is real', () => {
    const out = plain(renderValueReadout({ ...offlineEmpty, similarDecisions: 3 }, { mode: 'local' }));
    expect(out).toMatch(/3 similar decisions/i);
  });

  it('leaves cloud mode alone - a zero there is a measurement, not a gap', () => {
    // Cloud CAN write every one of these, so a zero is real information and the
    // no-vanity-collapse rule above still governs. Only the offline branch changes.
    const out = plain(renderValueReadout({ ...offlineEmpty, reuseRate: 0.4 }, { mode: 'cloud' }));
    expect(out).toMatch(/conflicts caught/i);
    expect(out).toMatch(/duplicates/i);
    expect(out).toMatch(/supersed/i);
  });

  it('still tells a local user which metrics need the cloud graph', () => {
    const out = plain(renderValueReadout(offlineEmpty, { mode: 'local' }));
    expect(out).toMatch(/cloud/i);
  });
});
