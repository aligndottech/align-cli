import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded' })) })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));
vi.mock('../lib/local-llm.js', () => ({
  synthesiseDetailed: vi.fn().mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } }),
  RECOMMENDED_OLLAMA_PULL: 'llama3.2',
}));

const searchDecisions = vi.hoisted(() => vi.fn());
const listDecisions = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ searchDecisions, listDecisions })),
}));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });

import { registerAskCommand } from '../commands/why.js';

async function ask(q = 'What decisions exist in this codebase?') {
  output.length = 0;
  const program = new Command();
  registerAskCommand(program);
  await program.parseAsync(['node', 'align', 'ask', q]);
  return output.join('\n');
}

/**
 * ALI-771. A tester ran the question `setup --local`'s own outro tells you to ask, against a
 * graph he had just filled, and was told to go and build his graph.
 *
 * `align ask` printed "No decisions found. Build your graph first" whenever SEARCH returned
 * zero - which is a claim about the graph made from evidence that only covers the query.
 * Reproduced against a real 3-decision local graph: the meta-question matches nothing
 * semantically (it is about the graph, not in it) while "why postgres" returns a 48% match.
 *
 * The remedy for an empty graph is to import. The remedy for a query that matched nothing is
 * to ask differently. Sending someone to re-import a graph that is already full is the worse
 * of the two errors, because it looks like the import never worked.
 */
describe('align ask: an empty graph and a query that matched nothing are different', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    searchDecisions.mockReset();
    listDecisions.mockReset();
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic' });
  });

  it('tells a user with a genuinely empty graph to import', async () => {
    listDecisions.mockResolvedValue([]);
    const out = await ask();
    expect(out).toMatch(/Build your graph first/);
    expect(out).toMatch(/align import git/);
  });

  it('does NOT tell a user whose graph has decisions to build one', async () => {
    listDecisions.mockResolvedValue([{ id: 'a', title: 'Chose Postgres' }]);
    const out = await ask();
    expect(out).not.toMatch(/Build your graph first/);
  });

  it('says the query matched nothing, and that the graph is not empty', async () => {
    listDecisions.mockResolvedValue([{ id: 'a', title: 'Chose Postgres' }]);
    const out = await ask();
    expect(out).toMatch(/nothing matched|no match/i);
    // Naming a way forward that is not "import again", which is the wrong remedy here.
    expect(out).toMatch(/align decisions list/);
  });

  /**
   * The suggested command has to be runnable AS PRINTED. A bare `align decisions list`
   * resolves to the cloud default and 401s for a local-only user (ALI-772), so printing it
   * to the person this message exists for would hand them a second auth error on top of the
   * one this fix is about.
   *
   * The first version of this suite asserted /align decisions list/ alone, which the BARE
   * form satisfies - so it would have passed against exactly the bug. A review bot caught
   * that; the exact string is pinned now, in both directions.
   */
  // ALI-772 made `decisions` prefer the local graph like ask, search and import, so the bare
  // command is now correct for every user. It was qualified while that was not true.
  it('suggests the bare command, with no env flag to decode', async () => {
    for (const env of ['local', 'prod'] as const) {
      resolveEnv.mockReturnValue(env);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'Chose Postgres' }]);
      const out = await ask();
      expect(out).toContain('align decisions list');
      expect(out).not.toContain('--env');
    }
  });

  /**
   * The extra lookup must never make things worse than before. A cloud user whose token has
   * expired gets a throw here, and the old message - which is right often enough - has to
   * survive that rather than the command dying on a diagnostic.
   */
  it('falls back to the original message when the graph cannot be counted', async () => {
    listDecisions.mockRejectedValue(new Error('401 unauthorized'));
    const out = await ask();
    expect(out).toMatch(/Build your graph first/);
  });
});

// ALI-795: a non-empty answer IS the funnel's activation moment. Emitted from the
// success path only - an empty result is not a useful decision, whatever the reason.
const recordFunnelStage = vi.hoisted(() => vi.fn());
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

// Superset of the file's earlier local-llm mock (last registration wins): the non-empty
// path below is the first test in this file to reach noProviderHintLines(), which the
// original mock did not export - the renderer threw and exit(1)'d, a red for the wrong
// reason (caught by reading the failure message, per tdd.md).
vi.mock('../lib/local-llm.js', () => ({
  synthesiseDetailed: vi.fn().mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } }),
  RECOMMENDED_OLLAMA_PULL: 'llama3.2',
  noProviderHintLines: () => [],
}));

/**
 * ALI-798: the local graph now has a repo dimension, and it introduces a SECOND way for
 * "an empty graph" and "a query that matched nothing" to be confused - scoped to a repo
 * with nothing in it, while the graph as a whole is full. The `{ all: true }` on the
 * "is the graph empty" check exists specifically so this diagnostic answers "does the
 * GRAPH have anything" rather than "does THIS REPO" - the same defect this ticket exists
 * to fix, reachable through the empty-state message if that check were scoped too.
 */
describe('align ask: a repo with nothing in it is not an empty graph (ALI-798)', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    searchDecisions.mockReset();
    listDecisions.mockReset();
  });

  it('names the repo and suggests --all, rather than "build your graph first"', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic', scope: 'github.com/acme/api' });
    listDecisions.mockResolvedValue([{ id: 'a', title: 'From a different repo' }]);
    const out = await ask();
    expect(out).not.toMatch(/Build your graph first/);
    expect(out).toMatch(/github\.com\/acme\/api/);
    expect(out).toMatch(/--all/);
  });

  it('checks emptiness with { all: true } - unscoped - not whatever repo the search used', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic', scope: 'github.com/acme/api' });
    listDecisions.mockResolvedValue([]);
    await ask();
    expect(listDecisions).toHaveBeenCalledWith(expect.objectContaining({ all: true }));
  });

  it('prints "Answering from X" ahead of a non-empty scoped answer', async () => {
    searchDecisions.mockResolvedValue({
      results: [{ id: '1', title: 'Use JWT for sessions', summary: 's', platform: 'git', similarity: 0.8, source_url: null }],
      count: 1,
      strategy: 'semantic',
      scope: 'github.com/acme/api',
    });
    const out = await ask('why jwt');
    expect(out).toMatch(/Answering from github\.com\/acme\/api/);
  });

  it('says nothing about scope when the search was unscoped (no repo, or --all)', async () => {
    searchDecisions.mockResolvedValue({
      results: [{ id: '1', title: 'Use JWT for sessions', summary: 's', platform: 'git', similarity: 0.8, source_url: null }],
      count: 1,
      strategy: 'semantic',
      scope: null,
    });
    const out = await ask('why jwt');
    expect(out).not.toMatch(/Answering from/);
  });

  it('passes --repo and --all through to searchDecisions as the scope', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic', scope: null });
    listDecisions.mockResolvedValue([]);
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'why jwt', '--repo', 'api']);
    expect(searchDecisions).toHaveBeenCalledWith('why jwt', 8, { repo: 'api', all: undefined });

    searchDecisions.mockClear();
    const program2 = new Command();
    registerAskCommand(program2);
    await program2.parseAsync(['node', 'align', 'ask', 'why jwt', '--all']);
    expect(searchDecisions).toHaveBeenCalledWith('why jwt', 8, { repo: undefined, all: true });
  });
});

describe('first_useful_decision funnel stage (ALI-795)', () => {
  beforeEach(() => {
    recordFunnelStage.mockReset();
    resolveEnv.mockReturnValue('local');
    searchDecisions.mockReset();
    listDecisions.mockReset();
  });

  it('emits when ask returns at least one result', async () => {
    searchDecisions.mockResolvedValue({
      results: [{ id: '1', title: 'Use JWT for sessions', summary: 's', platform: 'git', similarity: 0.8, source_url: null }],
      count: 1,
      strategy: 'semantic',
    });
    await ask('why jwt');
    expect(recordFunnelStage).toHaveBeenCalledWith(expect.anything(), 'first_useful_decision', 'ask');
  });

  it('emits nothing on an empty result, empty graph or not', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic' });
    listDecisions.mockResolvedValue([]);
    await ask();
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });
});
