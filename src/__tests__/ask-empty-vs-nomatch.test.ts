import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded' })) })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('local') }));
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
    expect(out).toMatch(/align decisions list|different|rephrase/i);
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
