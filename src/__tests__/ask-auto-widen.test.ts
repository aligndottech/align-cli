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
  // isAbstention/ABSTENTION_SENTINEL stay REAL: the widen trigger under test IS the
  // agreement between the detector and the sentinel, and mocking both would let the
  // two drift while this suite stayed green.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ABSTENTION_SENTINEL: actual.ABSTENTION_SENTINEL,
    isAbstention: actual.isAbstention,
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

  it('prints the abstention once when the whole graph cannot answer either', async () => {
    searchDecisions.mockResolvedValueOnce(scoped([SCOPED_HIT])).mockResolvedValueOnce(global([GLOBAL_HIT]));
    synthesiseDetailed
      .mockResolvedValueOnce({ ok: true, text: ABSTENTION_SENTINEL })
      .mockResolvedValueOnce({ ok: true, text: ABSTENTION_SENTINEL });

    const out = await ask();

    const mentions = out.split(ABSTENTION_SENTINEL).length - 1;
    expect(mentions).toBe(1);
    // Both passes abstained identically, so print the one whose framing is accurate:
    // the whole graph was searched, and saying so beats naming a repo it went past.
    expect(out).toMatch(/whole graph/i);
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
