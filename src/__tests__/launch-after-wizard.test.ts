/**
 * L2: one predicate decides whether bare `align` opens the agent once the wizard ends.
 * default-action.ts gates on it, and setup.ts's outro reads it to choose between
 * "Opening <Agent>. Ask it: ..." and the run-align instruction - so the outro says
 * "Opening" exactly when default-action launches.
 */
import { describe, expect, it } from 'vitest';
import { launchesAfterWizard } from '../lib/launch/launch.js';

const base = { localGraph: true, agent: 'claude-code', env: {}, isTTY: true };

describe('launchesAfterWizard', () => {
  it('launches with a local graph, an agent, a terminal and nothing suppressing it', () => {
    expect(launchesAfterWizard(base)).toBe(true);
    expect(launchesAfterWizard({ ...base, agent: 'codex' })).toBe(true);
  });

  it.each([
    ['no local graph (wizard cancelled)', { localGraph: false }],
    ['no agent chosen', { agent: null }],
    ['no terminal', { isTTY: false }],
    ['ALIGN_NO_LAUNCH', { env: { ALIGN_NO_LAUNCH: '1' } }],
    ['ALIGN_WRAPPED (already inside an agent)', { env: { ALIGN_WRAPPED: '1' } }],
  ])('does not launch: %s', (_name, over) => {
    expect(launchesAfterWizard({ ...base, ...over })).toBe(false);
  });

  it('an empty ALIGN_NO_LAUNCH does not count as set', () => {
    expect(launchesAfterWizard({ ...base, env: { ALIGN_NO_LAUNCH: '' } })).toBe(true);
  });
});
