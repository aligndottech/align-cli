/**
 * ALI-831: one writer of "which kind of actor decided", mirroring align-stack's
 * deciderKind.ts (deriveDeciderKind) with the session platform added - the cloud's
 * AGENT_PLATFORMS gains 'agent-session' in ALI-832; until then a pushed session row is
 * classified there by whatever that set holds.
 *
 * Two examples per side, so a hardcoded answer cannot pass.
 */
import { describe, expect, it } from 'vitest';
import { deciderLabel, deriveDeciderKind } from '../lib/decider-kind.js';

describe('deriveDeciderKind', () => {
  it.each(['agent-session', 'mcp', 'github-actions'])('%s is a machine surface, so agent', (platform) => {
    expect(deriveDeciderKind(platform)).toBe('agent');
  });

  it.each(['cli', 'git', 'slack', 'something-new'])('%s classifies human, including an unrecognised value', (platform) => {
    expect(deriveDeciderKind(platform)).toBe('human');
  });
});

describe('deciderLabel: the words every renderer prints, verbatim across lanes', () => {
  it('names an unratified agent claim', () => {
    expect(deciderLabel({ decider_kind: 'agent', ratified_by: null, ratified_at: null })).toBe('agent-decided, unratified');
  });

  it('names who ratified and on which day, date only', () => {
    expect(deciderLabel({ decider_kind: 'agent', ratified_by: 'tom@align.tech', ratified_at: '2026-09-03T14:05:00.000Z' }))
      .toBe('agent-decided, ratified by tom@align.tech on 2026-09-03');
  });

  it.each([
    ['human', null],
    ['unknown', null],
    [null, null],
  ])('says nothing for %s: only an agent claim carries a label', (kind, expected) => {
    expect(deciderLabel({ decider_kind: kind, ratified_by: null, ratified_at: null })).toBe(expected);
  });
});
