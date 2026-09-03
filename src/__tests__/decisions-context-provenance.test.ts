/**
 * ALI-831: `align context sync` is consumed by agents that only read files, so the
 * agent-decided/unratified label has to be IN THE TEXT. Unratified agent claims render in
 * their own section, separated from the decisions the rest of the file states as fact, and
 * carry the same label decisions-context and the local MCP server both print
 * (deciderLabel, shared with decider-kind.ts).
 *
 * Test List:
 * 1. an unratified agent claim renders in a distinct section, not the main list
 * 2. a ratified agent decision, and a human decision, render in the main list - the section
 *    exists only for the specific shape it is for
 * 3. no claims: no section header at all, so a clean graph's file reads exactly as before
 * 4. idempotent and order-independent with the new section present
 */
import { describe, expect, it } from 'vitest';
import { type ContextDecision, renderDecisionsFile } from '../lib/decisions-context.js';

const CLAIM: ContextDecision = {
  title: 'Agent picked sqlite for the cache',
  cite: 'agent-cli#1',
  sourceUrl: 'claude-session://s1/m1',
  deciderKind: 'agent',
};
const RATIFIED: ContextDecision = {
  title: 'Agent picked postgres, ratified',
  deciderKind: 'agent',
  ratifiedBy: 'tom@align.tech',
  ratifiedAt: '2026-09-03T14:00:00.000Z',
};
const HUMAN: ContextDecision = { title: 'Use trunk-based development', deciderKind: 'human' };

describe('the claims section', () => {
  it('renders an unratified agent claim there, with the label in the line', () => {
    const out = renderDecisionsFile([CLAIM]);
    expect(out).toMatch(/agent-decided, unratified/);
    expect(out).toContain('Agent picked sqlite for the cache');
  });

  it('does not put a ratified agent decision or a human decision in that section', () => {
    const out = renderDecisionsFile([RATIFIED, HUMAN]);
    expect(out).not.toMatch(/unratified/);
    // The ratified one still carries its own label, in the main list.
    expect(out).toMatch(/agent-decided, ratified by tom@align\.tech on 2026-09-03/);
  });

  it('prints no section header at all when nothing is an unratified claim', () => {
    const out = renderDecisionsFile([RATIFIED, HUMAN]);
    expect(out.toLowerCase()).not.toMatch(/unratified.*\n-|^##.*claim/im);
  });

  it('separates the two: a claim in its section, everything else in the main list, both present', () => {
    const out = renderDecisionsFile([CLAIM, HUMAN]);
    const claimIdx = out.indexOf('Agent picked sqlite for the cache');
    const humanIdx = out.indexOf('Use trunk-based development');
    expect(claimIdx).toBeGreaterThan(-1);
    expect(humanIdx).toBeGreaterThan(-1);
    expect(claimIdx).not.toBe(humanIdx);
  });

  it('stays idempotent and order-independent with claims present', () => {
    const mixed = [HUMAN, CLAIM, RATIFIED];
    expect(renderDecisionsFile(mixed)).toBe(renderDecisionsFile(mixed));
    expect(renderDecisionsFile([...mixed].reverse())).toBe(renderDecisionsFile(mixed));
  });
});
