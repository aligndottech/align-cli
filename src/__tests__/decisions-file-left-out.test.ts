/**
 * The note saying how many graph items the decisions file does not list.
 * 1. it states the count and nothing about what those items are: --limit cuts decisions too, not only fixes
 * 2. it sits before the agent-claims section, so it never reads as part of it
 */
import { describe, expect, it } from 'vitest';
import { renderDecisionsFile } from '../lib/decisions-context.js';

describe('the left-out note', () => {
  it('says how many are not listed, without saying they are fixes', () => {
    const text = renderDecisionsFile([{ title: 'Use Postgres for events', kind: 'decision' }], { leftOut: 45 });
    expect(text).toContain('45 more items in the graph are not listed here');
    expect(text).not.toMatch(/fixes, tests/);
  });

  it('comes before the agent-claims section, not inside it', () => {
    const text = renderDecisionsFile([
      { title: 'Use Postgres for events', kind: 'decision' },
      { title: 'Cache the token for an hour', deciderKind: 'agent' },
    ], { leftOut: 3 });
    const note = text.indexOf('3 more items in the graph are not listed here');
    const claims = text.indexOf('## Agent-decided, not yet ratified');
    expect(note).toBeGreaterThan(-1);
    expect(claims).toBeGreaterThan(-1);
    expect(note).toBeLessThan(claims);
  });
});
