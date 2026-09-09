/**
 * ALI-938: inviteNudgeLine and answeredBySomeoneElse - the pure logic behind the invite
 * nudge that replaces the three "Share this graph: <pricing URL>" lines.
 *
 * Test List:
 * 1. inviteNudgeLine: each reason returns a distinct line, all containing the invite hint
 * 2. inviteNudgeLine: default (no reason passed) matches 'value'
 * 3. answeredBySomeoneElse: my own decision (matching email) -> false
 * 4. answeredBySomeoneElse: a teammate's decision (different email) -> true
 * 5. answeredBySomeoneElse: no local identity to compare against -> false
 * 6. answeredBySomeoneElse: name-only match on both sides (same person) -> false
 * 7. answeredBySomeoneElse: name-only, different names -> true
 * 8. answeredBySomeoneElse: author has an email, I only know my name -> can't compare -> false
 * 9. answeredBySomeoneElse: empty author list -> false
 */
import { describe, expect, it } from 'vitest';
import { answeredBySomeoneElse, inviteNudgeLine } from '../lib/invite-prompt.js';

describe('inviteNudgeLine', () => {
  it('the value reason names the invite command', () => {
    expect(inviteNudgeLine('value')).toContain('align invite');
  });

  it('the answered-by-other reason is distinct and names the invite command', () => {
    const line = inviteNudgeLine('answered-by-other');
    expect(line).toContain('align invite');
    expect(line).not.toBe(inviteNudgeLine('value'));
  });

  it('the empty-with-committers reason is distinct and names the invite command', () => {
    const line = inviteNudgeLine('empty-with-committers');
    expect(line).toContain('align invite');
    expect(line).not.toBe(inviteNudgeLine('value'));
    expect(line).not.toBe(inviteNudgeLine('answered-by-other'));
  });

  it('defaults to the value reason when none is given', () => {
    expect(inviteNudgeLine()).toBe(inviteNudgeLine('value'));
  });

  it('never carries the retired pricing URL', () => {
    for (const reason of ['value', 'answered-by-other', 'empty-with-committers'] as const) {
      expect(inviteNudgeLine(reason)).not.toContain('pricing');
    }
  });
});

describe('answeredBySomeoneElse', () => {
  it('is false for my own decision (matching email)', () => {
    const mine = { email: 'tom@align.tech', name: 'Tom Knee' };
    expect(answeredBySomeoneElse([{ email: 'tom@align.tech', name: 'Tom Knee' }], mine)).toBe(false);
  });

  it('is true for a teammate\'s decision (different email)', () => {
    const mine = { email: 'tom@align.tech', name: 'Tom Knee' };
    expect(answeredBySomeoneElse([{ email: 'dan@align.tech', name: 'Dan' }], mine)).toBe(true);
  });

  it('is false with no local identity to compare against - never guesses', () => {
    const nobody = { email: null, name: null };
    expect(answeredBySomeoneElse([{ email: 'dan@align.tech', name: 'Dan' }], nobody)).toBe(false);
  });

  it('is false when both sides have only a matching name', () => {
    const mine = { email: null, name: 'Tom Knee' };
    expect(answeredBySomeoneElse([{ name: 'Tom Knee' }], mine)).toBe(false);
  });

  it('is true when both sides have only a name, and the names differ', () => {
    const mine = { email: null, name: 'Tom Knee' };
    expect(answeredBySomeoneElse([{ name: 'Dan' }], mine)).toBe(true);
  });

  it('cannot compare an email against a name, so it stays false', () => {
    const mine = { email: null, name: 'Tom Knee' };
    expect(answeredBySomeoneElse([{ email: 'dan@align.tech' }], mine)).toBe(false);
  });

  it('is false for an empty author list', () => {
    const mine = { email: 'tom@align.tech', name: 'Tom Knee' };
    expect(answeredBySomeoneElse([], mine)).toBe(false);
  });

  it('is true if ANY author in a mixed list differs, not just the first', () => {
    const mine = { email: 'tom@align.tech', name: 'Tom Knee' };
    expect(answeredBySomeoneElse(
      [{ email: 'tom@align.tech' }, null, { email: 'dan@align.tech' }],
      mine,
    )).toBe(true);
  });
});
