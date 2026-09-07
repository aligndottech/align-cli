import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ mode: 'local-embedded' })),
    getConnectorFields: vi.fn(() => null),
  })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));
const recordFunnelStage = vi.hoisted(() => vi.fn());
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

const synthesiseDetailed = vi.hoisted(() => vi.fn());
vi.mock('../lib/local-llm.js', async (importOriginal) => {
  // isAbstention/ABSTENTION_SENTINEL/explainAbstention stay REAL: the widen trigger
  // under test IS the agreement between the detector and the sentinel, and mocking
  // any of the three would let them drift while this suite stayed green. explainAbstention
  // also has to be real because why.ts calls it unconditionally at the print site
  // (ALI-895) - a stubbed-out mock leaves it undefined and every test in this file
  // that reaches a printed answer throws.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ABSTENTION_SENTINEL: actual.ABSTENTION_SENTINEL,
    isAbstention: actual.isAbstention,
    explainAbstention: actual.explainAbstention,
    synthesiseDetailed,
    RECOMMENDED_OLLAMA_PULL: 'llama3.2',
    noProviderHintLines: () => [],
  };
});

const searchDecisions = vi.hoisted(() => vi.fn());
const listDecisions = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ searchDecisions, listDecisions })),
}));

// Event order across the spinner, the gateway and the model, for the spinner-lifetime
// tests below. `output` alone cannot see WHEN the spinner stopped relative to the awaits.
const events = vi.hoisted(() => [] as string[]);
const spinner = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  fail: vi.fn(),
}));
vi.mock('ora', () => ({
  default: vi.fn(() => {
    spinner.start.mockImplementation(() => { events.push('spin'); return spinner; });
    spinner.stop.mockImplementation(() => { events.push('stop'); return spinner; });
    spinner.fail.mockImplementation(() => { events.push('fail'); return spinner; });
    return spinner;
  }),
}));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });

import { ABSTENTION_SENTINEL } from '../lib/local-llm.js';
import { registerAskCommand } from '../commands/why.js';

const SCOPED_HIT = {
  id: 's1', title: 'A weak lookalike in this repo', summary: 'tangential', platform: 'git',
  similarity: 0.4, source_url: null,
};
const GLOBAL_HIT = {
  id: 'g1', title: 'The real decision, in another repo', summary: 'the actual answer',
  platform: 'github', similarity: 0.9, source_url: null,
};

function scoped(results: unknown[]) {
  return { results, count: results.length, strategy: 'semantic', scope: 'github.com/acme/api' };
}
function global(results: unknown[]) {
  return { results, count: results.length, strategy: 'semantic', scope: null };
}

async function ask(...extra: string[]) {
  output.length = 0;
  const program = new Command();
  registerAskCommand(program);
  await program.parseAsync(['node', 'align', 'ask', 'why did the other repo do X', ...extra]);
  // Whitespace-normalised: the renderer word-wraps answers at 76 columns, so a phrase
  // asserted with toContain can be split mid-word-boundary by a newline and read as absent.
  return output.join('\n').replace(/\s+/g, ' ');
}

/**
 * Found live 2026-09-02, the same evening ALI-798's repo scoping shipped: a cross-repo
 * question asked from the wrong directory got "The context does not answer this
 * question" plus a hint to re-run with --all - the answer existed, one flag away. The
 * scoping default is right (unscoped search blended repos, the bug ALI-798 fixed) and
 * making the USER re-run is not: the tool knows the scoped attempt failed, so it widens
 * itself and says so. Both prior incidents stay honoured - scoped first for precision,
 * whole graph before giving up.
 */
describe('align ask auto-widens a scoped search that found nothing', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    searchDecisions.mockReset();
    listDecisions.mockReset();
    synthesiseDetailed.mockReset();
    recordFunnelStage.mockReset();
    synthesiseDetailed.mockResolvedValue({ ok: false, failure: { kind: 'providers_unavailable', tried: [] } });
  });

  it('re-searches the whole graph and answers from it', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([])).mockResolvedValueOnce(global([GLOBAL_HIT]));

    const out = await ask();

    expect(searchDecisions).toHaveBeenCalledTimes(2);
    expect(searchDecisions).toHaveBeenNthCalledWith(2, expect.any(String), expect.any(Number), { all: true });
    expect(out).toContain('The real decision, in another repo');
  });

  it('says it widened, naming the repo that had nothing', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([])).mockResolvedValueOnce(global([GLOBAL_HIT]));

    const out = await ask();

    expect(out).toMatch(/github\.com\/acme\/api/);
    expect(out).toMatch(/whole graph/i);
  });

  it('when the whole graph has nothing either, says so - and does not suggest --all', async () => {
    searchDecisions.mockResolvedValue(scoped([]));
    listDecisions.mockResolvedValue([{ id: 'a', title: 'exists' }]);

    const out = await ask();

    expect(searchDecisions).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/rest of your graph|anywhere/i);
    // The whole graph was already searched; suggesting --all would promise a re-run
    // that cannot find more than this run just did.
    expect(out).not.toMatch(/--all/);
  });

  it('respects an explicit --repo: no widening behind the user\'s back', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic', scope: 'github.com/acme/api' });
    listDecisions.mockResolvedValue([]);

    await ask('--repo', 'api');

    expect(searchDecisions).toHaveBeenCalledTimes(1);
  });

  it('does not double-search under --all', async () => {
    searchDecisions.mockResolvedValue(global([]));
    listDecisions.mockResolvedValue([]);

    await ask('--all');

    expect(searchDecisions).toHaveBeenCalledTimes(1);
  });
});

describe('align ask auto-widens when scoped context makes the model abstain', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    searchDecisions.mockReset();
    listDecisions.mockReset();
    synthesiseDetailed.mockReset();
    recordFunnelStage.mockReset();
  });

  it('re-searches, re-synthesises, and prints the whole-graph answer', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT])).mockResolvedValueOnce(global([GLOBAL_HIT]));
    synthesiseDetailed
      .mockResolvedValueOnce({ ok: true, text: ABSTENTION_SENTINEL })
      .mockResolvedValueOnce({ ok: true, text: 'It stopped because the suffix diverged the directories.' });

    const out = await ask();

    expect(searchDecisions).toHaveBeenCalledTimes(2);
    expect(synthesiseDetailed).toHaveBeenCalledTimes(2);
    // The second synthesis got the GLOBAL context, not the scoped one.
    expect(synthesiseDetailed).toHaveBeenNthCalledWith(2, expect.any(String),
      [expect.objectContaining({ id: 'g1' })]);
    expect(out).toContain('It stopped because the suffix diverged the directories.');
    expect(out).not.toContain(ABSTENTION_SENTINEL);
  });

  // ALI-895: the actual bug, exercised through the real caller rather than only through
  // the unit-level isAbstention test. Before the fix the scoped answer below - a real
  // paraphrase observed live 2026-09-05, not the sentinel itself - was NOT recognised as
  // an abstention, so the widen never fired and the search-call count stayed at 1. Assert
  // on the widened call happening (not just on the final text) so a detector fix with no
  // wiring behind it cannot read as success.
  it('widens on a paraphrased abstention, not only the exact sentinel (the actual bug)', async () => {
    const paraphrase =
      'The context does not answer when you stopped blocking PRs on the Align gate ' +
      'or provide a single moment identifying that decision, though it does describe the mechanism.';
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT])).mockResolvedValueOnce(global([GLOBAL_HIT]));
    synthesiseDetailed
      .mockResolvedValueOnce({ ok: true, text: paraphrase })
      .mockResolvedValueOnce({ ok: true, text: 'It stopped once the ALI-825 gate rollout completed.' });

    const out = await ask();

    expect(searchDecisions).toHaveBeenCalledTimes(2);
    expect(synthesiseDetailed).toHaveBeenCalledTimes(2);
    expect(out).toContain('It stopped once the ALI-825 gate rollout completed.');
  });

  it('prints the abstention once when the whole graph cannot answer either', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT])).mockResolvedValueOnce(global([GLOBAL_HIT]));
    synthesiseDetailed
      .mockResolvedValueOnce({ ok: true, text: ABSTENTION_SENTINEL })
      .mockResolvedValueOnce({ ok: true, text: ABSTENTION_SENTINEL });

    const out = await ask();

    // ALI-895: ABSTENTION_SENTINEL is a non-prose token now, translated to English
    // (explainAbstention) before anything reaches the terminal - so the prose it
    // stands for is what appears, once, and the raw token appears nowhere.
    const mentions = out.split('The context does not answer this question.').length - 1;
    expect(mentions).toBe(1);
    expect(out).not.toContain(ABSTENTION_SENTINEL);
    // Both passes abstained identically, so print the one whose framing is accurate:
    // the whole graph was searched, and saying so beats naming a repo it went past.
    expect(out).toMatch(/whole graph/i);
  });

  // ALI-895: the concrete leak this bug fix has to rule out - a raw non-prose token is
  // meaningless to a person reading a terminal, so it must never be what they see, even
  // on the deny-then-deliver path where the model kept talking past the marker.
  it('never leaks the raw <<NO_ANSWER>> marker to the terminal, even with a tail', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT])).mockResolvedValueOnce(global([GLOBAL_HIT]));
    synthesiseDetailed
      .mockResolvedValueOnce({ ok: true, text: ABSTENTION_SENTINEL })
      .mockResolvedValueOnce({ ok: true, text: `${ABSTENTION_SENTINEL} Though align-cli#231 hints at the cause.` });

    const out = await ask();

    expect(out).not.toContain(ABSTENTION_SENTINEL);
    expect(out).toContain('The context does not answer this question. Though align-cli#231 hints at the cause.');
  });

  /**
   * Measured against a real model (probe 2, 2026-09-02): on implicit-only context the
   * model can STILL emit the sentinel and keep talking - the deny-then-deliver output
   * the prompt forbids, with the actual answer in the tail. A denial with an
   * informative tail beats a bare sentinel, so a bare-sentinel scoped answer adopts
   * WHATEVER the widened pass produced - even another denial-shaped answer - while a
   * scoped answer that already carries a tail only upgrades to a CLEAN widened answer.
   */
  it('a bare-sentinel scoped answer adopts a denial-with-tail widened answer', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT])).mockResolvedValueOnce(global([GLOBAL_HIT]));
    synthesiseDetailed
      .mockResolvedValueOnce({ ok: true, text: ABSTENTION_SENTINEL })
      .mockResolvedValueOnce({
        ok: true,
        text: `${ABSTENTION_SENTINEL} While align-cli#231 shows the suffix was removed to converge the directories.`,
      });

    const out = await ask();

    expect(out).toContain('the suffix was removed to converge the directories');
    expect(out).toMatch(/whole graph/i);
  });

  it('a denial-with-tail scoped answer only upgrades to a CLEAN widened answer', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT])).mockResolvedValueOnce(global([GLOBAL_HIT]));
    synthesiseDetailed
      .mockResolvedValueOnce({
        ok: true,
        text: `${ABSTENTION_SENTINEL} Though the scoped decisions hint at a directory bug.`,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: `${ABSTENTION_SENTINEL} The widened context hints at the same directory bug.`,
      });

    const out = await ask();

    // Neither pass produced a clean answer; keep the scoped one, whose header is honest.
    expect(out).toContain('the scoped decisions hint at a directory bug');
    expect(out).not.toContain('widened context hints');
    expect(out).toMatch(/Answering from github\.com\/acme\/api/);
  });

  it('does not widen or re-synthesise when the scoped answer is a real answer', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT]));
    synthesiseDetailed.mockResolvedValueOnce({ ok: true, text: 'A direct scoped answer.' });

    const out = await ask();

    expect(searchDecisions).toHaveBeenCalledTimes(1);
    expect(synthesiseDetailed).toHaveBeenCalledTimes(1);
    expect(out).toContain('A direct scoped answer.');
  });

  it('a synthesis FAILURE is not an abstention - no second call burned', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT]));
    synthesiseDetailed.mockResolvedValueOnce({ ok: false, failure: { kind: 'providers_unavailable', tried: [] } });

    await ask();

    expect(searchDecisions).toHaveBeenCalledTimes(1);
    expect(synthesiseDetailed).toHaveBeenCalledTimes(1);
  });
});

/**
 * Copilot on #236: the spinner stopped right after the first search, so every await
 * after it - the first synthesis, and the whole stage-2 widen (a second search plus a
 * second model call, seconds on a local model) - ran against a blank line. A CLI that
 * shows nothing for several seconds reads as hung, and a hung tool is the one thing a
 * sceptical developer does not give a second run. The spinner's lifetime is the
 * lifetime of the WORK: it stops right before the first line of output, whichever
 * branch prints it.
 */
describe('the spinner covers every await, and stops only for output', () => {
  const searchEvent = (value: unknown) => async () => { events.push('search'); return value; };
  const synthEvent = (value: unknown) => async () => { events.push('synth'); return value; };

  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    searchDecisions.mockReset();
    listDecisions.mockReset();
    synthesiseDetailed.mockReset();
    recordFunnelStage.mockReset();
    spinner.start.mockClear();
    spinner.stop.mockClear();
    spinner.fail.mockClear();
    events.length = 0;
  });

  it('stays up through the first synthesis and the whole stage-2 widen', async () => {
    searchDecisions
      .mockImplementationOnce(searchEvent(scoped([SCOPED_HIT])))
      .mockImplementationOnce(searchEvent(global([GLOBAL_HIT])));
    synthesiseDetailed
      .mockImplementationOnce(synthEvent({ ok: true, text: ABSTENTION_SENTINEL }))
      .mockImplementationOnce(synthEvent({ ok: true, text: 'The widened answer.' }));

    await ask();

    // Positive control on the harness itself: the work happened, in this order.
    expect(events.filter((e) => e !== 'spin' && e !== 'stop')).toEqual(['search', 'synth', 'search', 'synth']);
    // The claim: nothing stopped the spinner until every one of those had finished.
    expect(events.indexOf('stop')).toBeGreaterThan(events.lastIndexOf('synth'));
    expect(spinner.stop).toHaveBeenCalledTimes(1);
  });

  it('stays up through the first synthesis when there is nothing to widen', async () => {
    searchDecisions.mockImplementationOnce(searchEvent(scoped([SCOPED_HIT])));
    synthesiseDetailed.mockImplementationOnce(synthEvent({ ok: true, text: 'A direct scoped answer.' }));

    await ask();

    expect(events.indexOf('stop')).toBeGreaterThan(events.lastIndexOf('synth'));
    expect(spinner.stop).toHaveBeenCalledTimes(1);
  });

  it('still stops before the first printed line on the no-results path', async () => {
    searchDecisions.mockImplementation(searchEvent(scoped([])));
    listDecisions.mockResolvedValue([{ id: 'a', title: 'exists' }]);
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      events.push('log');
      output.push(a.join(' '));
    });

    try {
      await ask();
    } finally {
      spy.mockRestore();
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });
    }

    // Negative control for the two above: keeping the spinner up longer must not mean
    // printing over it. The first log line comes after the stop, never before.
    expect(events.indexOf('stop')).toBeGreaterThan(-1);
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('log'));
  });
});
