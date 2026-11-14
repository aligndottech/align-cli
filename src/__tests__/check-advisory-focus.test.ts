import { describe, expect, it } from 'vitest';
import { buildRelatedOutput } from '../commands/check.js';

/**
 * A long section's excerpt is the sentence that matches the edit, not whatever the cut left
 * behind (#583: a lead sentence too long for the room fell back to a 106 character word cut).
 */
const claude = { pre: true, format: 'claude', blockOnCritical: false } as const;
const ctx = (out: unknown): string => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
const excerptLine = (out: string): string => (out.split('\n').find((l) => l.startsWith('  ')) as string).trim();

const LEAD = '- **Lab tick rate**: The lab runs at about 70 frames a second, which is the rate a listen server plays at.';
const PHYSICS = 'Any time-dependent physics (drag, acceleration, timers) must use the tick delta, never frame counts.';
const FILLER = 'Screenshots are captured after the scene settles for two seconds and never before the first render completes.';
const section = `${LEAD} ${FILLER} ${PHYSICS} ${FILLER}`;

describe('excerpt picks the sentence that matches the edit', () => {
  it('shows the physics sentence whole when the edit is about drag and timers', () => {
    const out = ctx(buildRelatedOutput([{ id: 'a', title: 'Rules', summary: section }], claude, [], false, { kind: 'not_requested' }, 'apply drag to the player with a timers tick delta'));
    const line = excerptLine(out);
    expect(line).toContain(PHYSICS);
    expect(line.endsWith('...')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('shows a different sentence for a different edit, with the lead for context when both fit', () => {
    const lead = 'Rules for captures.';
    const shots = 'Screenshots wait two seconds for the scene to settle.';
    const text = `${lead} ${'Filler words go here and say nothing at all about it. '.repeat(4)}${shots} ${'More filler that is not relevant. '.repeat(3)}`;
    const out = ctx(buildRelatedOutput([{ id: 'b', title: 'Captures', summary: text }], claude, [], false, { kind: 'not_requested' }, 'screenshots settle'));
    const line = excerptLine(out);
    expect(line.startsWith(`${lead} ${shots}`)).toBe(true);
  });

  it('with no edit text keeps the lead sentences as before', () => {
    const out = ctx(buildRelatedOutput([{ id: 'c', title: 'Rules', summary: section }], claude));
    expect(excerptLine(out).startsWith(LEAD)).toBe(true);
  });
});

describe('a decision with a later decision on topic says so', () => {
  it('adds "later: <short id>" to its line', () => {
    const out = ctx(buildRelatedOutput([{ id: 'cd45e00aaaa', title: 'Tick rate', summary: 'Short.', later_on_topic: [{ id: 'a9dda39bbbb' }] }], claude));
    expect(out).toContain('Tick rate (later: a9dda39)');
  });

  it('names no later decision when none exists', () => {
    const out = ctx(buildRelatedOutput([{ id: 'x1', title: 'Plain', summary: 'Short.' }], claude));
    expect(out).not.toContain('later:');
  });
});
