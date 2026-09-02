/**
 * ALI-798: `align decisions list` gets the same `--repo`/`--all` scoping. Unlike
 * `ask`/`search`, this command builds a generic query-params object shared with
 * `--platform`/`--status`/`--space`, so the thing worth pinning is that `repo`/`all`
 * land in that SAME object - and only when resolveScopeOpts actually returned a scope
 * (never a stray `repo: undefined` key sent to the cloud gateway as a query param).
 */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listDecisions = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ listDecisions })) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded' })) })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));

vi.spyOn(console, 'log').mockImplementation(() => {});

import { registerDecisionsCommand } from '../commands/decisions/index.js';

async function list(args: string[]) {
  const program = new Command();
  registerDecisionsCommand(program);
  await program.parseAsync(['node', 'align', 'decisions', 'list', ...args]);
}

describe('align decisions list --repo/--all', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    listDecisions.mockReset();
    listDecisions.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it('passes --repo through in the params object', async () => {
    await list(['--repo', 'api']);
    expect(listDecisions).toHaveBeenCalledWith(expect.objectContaining({ repo: 'api' }));
  });

  it('passes --all through in the params object', async () => {
    await list(['--all']);
    expect(listDecisions).toHaveBeenCalledWith(expect.objectContaining({ all: true }));
  });

  it('sends neither key when no flag was given', async () => {
    await list([]);
    const params = listDecisions.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('repo');
    expect(params).not.toHaveProperty('all');
  });

  it('warns and sends neither key in cloud mode - never a silent no-op (ALI-505)', async () => {
    resolveEnv.mockReturnValue('prod');
    const logs: string[] = [];
    (console.log as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    await list(['--all']);
    const params = listDecisions.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('all');
    expect(logs.some((l) => /local mode/.test(l))).toBe(true);
  });
});
