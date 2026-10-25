import { describe, expect, it } from 'vitest';
import { firstDecision } from '../lib/first-decision.js';

/**
 * The newest decision is often not askable ("fix: error throwing in reply (#6299)"), and with
 * only one read the question fell back to the generic one on most graphs. A short page gives
 * the question a real decision to name, and the outro's starter prompts their titles.
 */
describe('firstDecision', () => {
  const client = (rows: Array<{ title?: string }>) => ({
    listDecisions: async (params: { limit?: number }) => rows.slice(0, params.limit),
  });

  it('names the first askable title in a page, not just the newest', async () => {
    const r = await firstDecision(client([{ title: 'Improved docs' }, { title: 'feat: switch to postgres (#3)' }]));
    expect(r).toEqual({
      hasDecisions: true,
      firstTitle: 'feat: switch to postgres (#3)',
      titles: ['Improved docs', 'feat: switch to postgres (#3)'],
    });
  });

  it('falls back to the newest title when none is askable', async () => {
    expect((await firstDecision(client([{ title: 'Improved docs' }]))).firstTitle).toBe('Improved docs');
  });

  it('an empty graph has no title', async () => {
    expect(await firstDecision(client([]))).toEqual({ hasDecisions: false, firstTitle: undefined, titles: [] });
  });

  it('a failed read is an empty graph, never a throw', async () => {
    const failing = { listDecisions: async () => { throw new Error('401'); } };
    expect(await firstDecision(failing)).toEqual({ hasDecisions: false, firstTitle: undefined, titles: [] });
  });
});
