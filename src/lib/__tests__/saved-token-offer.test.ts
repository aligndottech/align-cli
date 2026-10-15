import { describe, expect, it, vi } from 'vitest';
import { offerSavedTokens } from '../saved-token-offer.js';

// David (14 Oct) had a saved GitHub token and was never asked about it: the reuse question only came up after he
// ticked the connector in the picker, and connected connectors are not preselected. These pin the offer that now
// runs BEFORE the picker: one question per saved connector, the answer decides reuse, and nothing else is asked.
const GH = { id: 'github', label: 'GitHub' };
const LINEAR = { id: 'linear', label: 'Linear' };
const TEAMS = { id: 'teams', label: 'Microsoft Teams', tokenShortLived: true };
const saved = (...ids: string[]) => new Map(ids.map((id) => [id, { token: `${id}-token` }]));

function deps(answers: Array<boolean | symbol> = []) {
  const queue = [...answers];
  const ask = vi.fn(async () => queue.shift() ?? false);
  const CANCEL = Symbol('cancel');
  return { ask, isCancel: (v: unknown) => v === CANCEL, CANCEL };
}

describe('offerSavedTokens', () => {
  it('interactive, a saved token, yes: the connector is reused and was asked about once, by name', async () => {
    const d = deps([true]);
    const { reuse } = await offerSavedTokens([GH], saved('github'), { approve: false, interactive: true }, d);
    expect([...reuse]).toEqual(['github']);
    expect(d.ask).toHaveBeenCalledTimes(1);
    expect(d.ask.mock.calls[0]![0]).toMatch(/GitHub/);
  });

  it('interactive, a saved token, no: nothing is reused, so the connector gets a fresh paste later', async () => {
    const d = deps([false]);
    const { reuse } = await offerSavedTokens([GH], saved('github'), { approve: false, interactive: true }, d);
    expect(reuse.size).toBe(0);
    expect(d.ask).toHaveBeenCalledTimes(1);
  });

  it('only connectors with a saved token are asked about (two examples: one saved, one not)', async () => {
    const d = deps([true]);
    const { reuse } = await offerSavedTokens([GH, LINEAR], saved('github'), { approve: false, interactive: true }, d);
    expect([...reuse]).toEqual(['github']);
    expect(d.ask).toHaveBeenCalledTimes(1);
    expect(d.ask.mock.calls[0]![0]).not.toMatch(/Linear/);
  });

  it('each saved connector gets its own answer, in order (two examples)', async () => {
    const d = deps([true, false]);
    const { reuse } = await offerSavedTokens([GH, LINEAR], saved('github', 'linear'), { approve: false, interactive: true }, d);
    expect([...reuse]).toEqual(['github']);
    expect(d.ask).toHaveBeenCalledTimes(2);
  });

  it('--approve reuses every saved token without asking (scripted runs must not stop)', async () => {
    const d = deps();
    const { reuse } = await offerSavedTokens([GH, LINEAR], saved('github', 'linear'), { approve: true, interactive: true }, d);
    expect([...reuse].sort()).toEqual(['github', 'linear']);
    expect(d.ask).not.toHaveBeenCalled();
  });

  it('--approve never adds a connector to the run: only a terminal yes does (a re-run touches only what you pick)', async () => {
    const d = deps();
    const { answeredYes } = await offerSavedTokens([GH], saved('github'), { approve: true, interactive: true }, d);
    expect(answeredYes.size).toBe(0);
  });

  it('a terminal yes is marked for the run, so it is fetched even when the picker is left empty', async () => {
    const d = deps([true]);
    const { answeredYes } = await offerSavedTokens([GH], saved('github'), { approve: false, interactive: true }, d);
    expect([...answeredYes]).toEqual(['github']);
  });

  it('no terminal and no --approve: reuses nothing and asks nothing (the re-run line names the refresh command)', async () => {
    const d = deps();
    const { reuse } = await offerSavedTokens([GH], saved('github'), { approve: false, interactive: false }, d);
    expect(reuse.size).toBe(0);
    expect(d.ask).not.toHaveBeenCalled();
  });

  it('a short-lived token (Teams) is asked about with the fresh-paste default', async () => {
    const d = deps([false]);
    await offerSavedTokens([TEAMS], saved('teams'), { approve: false, interactive: true }, d);
    expect(d.ask.mock.calls[0]![0]).toMatch(/about an hour/);
    expect(d.ask.mock.calls[0]![1]).toBe(false);
  });

  it('a cancelled prompt counts as not reusing it, and the next saved connector is still asked', async () => {
    const d = deps();
    d.ask.mockResolvedValueOnce(d.CANCEL as never).mockResolvedValueOnce(true as never);
    const { reuse } = await offerSavedTokens([GH, LINEAR], saved('github', 'linear'), { approve: false, interactive: true }, d);
    expect([...reuse]).toEqual(['linear']);
    expect(d.ask).toHaveBeenCalledTimes(2);
  });

  it('Jira and Confluence share one question: one yes reuses both, one no reuses neither (one Atlassian token is one fact)', async () => {
    const JIRA = { id: 'jira', label: 'Jira', group: 'atlassian' };
    const CONF = { id: 'confluence', label: 'Confluence', group: 'atlassian' };
    const yes = deps([true]);
    const both = await offerSavedTokens([JIRA, CONF], saved('jira', 'confluence'), { approve: false, interactive: true }, yes);
    expect([...both.reuse].sort()).toEqual(['confluence', 'jira']);
    expect(yes.ask).toHaveBeenCalledTimes(1);
    expect(yes.ask.mock.calls[0]![0]).toMatch(/Jira and Confluence/);

    const no = deps([false]);
    const neither = await offerSavedTokens([JIRA, CONF], saved('jira', 'confluence'), { approve: false, interactive: true }, no);
    expect(neither.reuse.size).toBe(0);
    expect(no.ask).toHaveBeenCalledTimes(1);
  });
});
