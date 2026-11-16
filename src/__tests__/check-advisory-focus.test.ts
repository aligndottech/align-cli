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

describe('the matched sentence survives a tight budget (#583)', () => {
  const run = (summary: string, focus: string): string =>
    excerptLine(ctx(buildRelatedOutput([{ id: 'k', title: 'Rules', summary }], claude, [], false, { kind: 'not_requested' }, focus)));
  const BIG_LEAD = '- **Lab tick rate**: The lab runs at about 70 frames a second, which is the rate a listen server plays at on every machine we test.';
  const noise = (n: number): string => `Screenshots are captured after the scene settles for ${n} seconds and never before the first render.`;

  it('cuts a matched sentence that is longer than the budget instead of falling back to the opening', () => {
    const hit = `Frametime 0.1 was never a real clamp: it was ftos rounding in the console print path, ${'and the print path rounds every float it is given '.repeat(4)}so do not copy it.`;
    const line = run(`${BIG_LEAD} ${noise(1)} ${noise(2)} ${hit}`, 'host_frametime clamp near ftos rounding');
    expect(line).toContain('ftos rounding');
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith('...')).toBe(true);
  });

  it('keeps a clipped lead for context when the lead and the match do not both fit whole', () => {
    const hit = 'Frametime 0.1 was ftos rounding in the print path, not a clamp, so never copy it into a patch.';
    const line = run(`${BIG_LEAD} ${noise(1)} ${noise(2)} ${hit} ${noise(3)}`, 'frametime damp ftos rounding');
    expect(line).toContain(hit);
    expect(line.startsWith('- **Lab tick rate**')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('matches a decimal such as 0.1, which no four-letter word carries', () => {
    const hit = 'The value 0.1 came from rounding, so it is not a setting.';
    const line = run(`${BIG_LEAD} ${noise(1)} ${noise(2)} ${hit} ${noise(3)}`, 'x = 0.1');
    expect(line).toContain(hit);
  });

  it('prefers the sentence sharing a rare term over one sharing two common terms', () => {
    const common1 = 'Screenshots settle after the scene loads, and the scene loads slowly.';
    const rare = 'Zebrafish handling is the single exception to that rule.';
    const text = `${BIG_LEAD} ${common1} ${noise(1)} ${noise(2)} ${rare} ${noise(3)}`;
    expect(run(text, 'screenshots scene zebrafish')).toContain(rare);
    expect(run(text, 'screenshots scene zebrafish')).not.toContain(common1);
  });

  it('with an edit that matches nothing keeps the leading excerpt', () => {
    const line = run(`${BIG_LEAD} ${noise(1)} ${noise(2)} ${noise(3)}`, 'completely unrelated quantum thing');
    expect(line.startsWith('- **Lab tick rate**')).toBe(true);
    expect(line).not.toContain('seconds');
  });

  it('redacts a secret and strips controls inside the matched sentence, CRLF section included', () => {
    const hit = `Deploys use ghp_${'a1B2c3D4e5'.repeat(4)} for the zebrafish\u001b[31m step.`;
    const text = [BIG_LEAD, noise(1), noise(2), hit, noise(3)].join('\r\n');
    const line = run(text, 'zebrafish step deploys');
    expect(line).toContain('zebrafish');
    expect(line).not.toContain('ghp_a1B2');
    expect(line).not.toContain('\u001b');
  });

  it('holds 200 per decision and 800 in total with a match in every decision', () => {
    const ds = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, title: `Rule ${i}`, summary: `${BIG_LEAD} ${noise(1)} ${noise(2)} Zebrafish rule ${i} is deep in this section and matters. ${noise(3)}` }));
    const out = ctx(buildRelatedOutput(ds, claude, [], false, { kind: 'not_requested' }, 'zebrafish'));
    const lines = out.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(200));
    expect(lines.reduce((n, l) => n + l.length, 0)).toBeLessThanOrEqual(800);
  });
});
