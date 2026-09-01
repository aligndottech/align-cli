/**
 * ALI-798: `align search` gets the same `--repo`/`--all` scoping as `ask`.
 *
 * Test List:
 * 1. --repo passes {repo, all: undefined} to searchDecisions
 * 2. --all passes {repo: undefined, all: true}
 * 3. with neither flag, scope is undefined - searchDecisions applies its own default
 * 4. prints "Answering from X" when the result names a scope
 */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchDecisions = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ searchDecisions })) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded' })) })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });

import { registerSearchCommand } from '../commands/search.js';

async function search(args: string[]) {
  output.length = 0;
  const program = new Command();
  registerSearchCommand(program);
  await program.parseAsync(['node', 'align', 'search', ...args]);
  return output.join('\n');
}

describe('align search --repo/--all', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    searchDecisions.mockReset();
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic' });
  });
  afterEach(() => vi.clearAllMocks());

  it('passes --repo through as the scope', async () => {
    await search(['a query', '--repo', 'api']);
    expect(searchDecisions).toHaveBeenCalledWith('a query', 10, { repo: 'api', all: undefined });
  });

  it('passes --all through as the scope', async () => {
    await search(['a query', '--all']);
    expect(searchDecisions).toHaveBeenCalledWith('a query', 10, { repo: undefined, all: true });
  });

  it('passes undefined - no opinion - when neither flag is given', async () => {
    await search(['a query']);
    expect(searchDecisions).toHaveBeenCalledWith('a query', 10, undefined);
  });

  it('names the scope it answered from', async () => {
    searchDecisions.mockResolvedValue({
      results: [{ id: '1', title: 'Use Postgres', summary: 's', status: 'active' }],
      count: 1,
      strategy: 'semantic',
      scope: 'github.com/acme/api',
    });
    const out = await search(['a query']);
    expect(out).toMatch(/Answering from github\.com\/acme\/api/);
  });

  it('says nothing about scope when unscoped', async () => {
    searchDecisions.mockResolvedValue({
      results: [{ id: '1', title: 'Use Postgres', summary: 's', status: 'active' }],
      count: 1,
      strategy: 'semantic',
      scope: null,
    });
    const out = await search(['a query']);
    expect(out).not.toMatch(/Answering from/);
  });
});
