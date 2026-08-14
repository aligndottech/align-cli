import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerStatusCommand } from '../commands/status.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';

const client = {
  getStats: vi.fn().mockResolvedValue({ snapshots: 142 }),
  getConflictImpact: vi.fn().mockResolvedValue({ total: 6 }),
  getLinkCounts: vi.fn().mockResolvedValue({ duplicates_count: 9, supersessions_count: 4 }),
  getReuseRate: vi.fn().mockResolvedValue({ referenced: 92, rediscovered: 35, rate: 0.72 }),
  getHealth: vi.fn().mockResolvedValue({ compositeScore: { grade: 'B' } }),
};

const { getEnvironmentMock, localDb, createLocalDbMock } = vi.hoisted(() => {
  const localDb = {
    getStats: vi.fn(() => ({ decisions: 3 })),
    listLinks: vi.fn(() => []),
    close: vi.fn(),
  };
  return {
    getEnvironmentMock: vi.fn(),
    localDb,
    createLocalDbMock: vi.fn(() => localDb),
  };
});

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: getEnvironmentMock })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod') }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => client) }));
vi.mock('../lib/local-db.js', () => ({ createLocalDb: createLocalDbMock }));
vi.mock('../lib/local-mode.js', () => ({ getLocalDbPath: vi.fn(() => '/tmp/fallback.db') }));

const output: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  output.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a) => { output.push(a.join(' ')); });
  vi.mocked(resolveEnv).mockImplementation((e?: string) => (e as never) ?? ('prod' as never));
  getEnvironmentMock.mockReturnValue({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' });
});

const plain = () => output.join('\n').replace(/\[[0-9;]*m/g, '');

describe('align status (cloud value readout)', () => {
  it('prints the value readout from the gateway rollup', async () => {
    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'align', 'status']);

    const out = plain();
    expect(out).toMatch(/142 decisions/);
    expect(out).toMatch(/6 conflicts caught/i);
    expect(out).toMatch(/9 duplicates/i);
    expect(out).toMatch(/72%/);
  });

  it('resolves the env with preferLocalEmbedded, so a no-account local user is not silently sent to the cloud', async () => {
    // Without this, an unauthenticated local user's five cloud requests all 401, every one is
    // swallowed by settle(), and status prints an all-zero readout - a silent wrong answer.
    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'align', 'status']);

    expect(vi.mocked(resolveEnv)).toHaveBeenCalledWith(undefined, { preferLocalEmbedded: true });
  });
});

describe('align status (local-embedded mode, ALI-505)', () => {
  beforeEach(() => {
    vi.mocked(resolveEnv).mockReturnValue('local' as never);
    getEnvironmentMock.mockReturnValue({ mode: 'local-embedded', localDbPath: '/tmp/graph.db' });
  });

  it('reads the local graph instead of calling the gateway', async () => {
    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'align', 'status']);

    const out = plain();
    expect(out).toMatch(/3 decisions in your graph/);
    // The local footer: reuse rate and health genuinely need the cloud graph.
    expect(out).toMatch(/need the cloud graph/);
    expect(createLocalDbMock).toHaveBeenCalledWith('/tmp/graph.db');
    expect(localDb.close).toHaveBeenCalled();
    expect(vi.mocked(createGatewayClient)).not.toHaveBeenCalled();
  });

  it('falls back to the default local db path when the env has none recorded', async () => {
    getEnvironmentMock.mockReturnValue({ mode: 'local-embedded' });
    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'align', 'status']);

    expect(createLocalDbMock).toHaveBeenCalledWith('/tmp/fallback.db');
  });
});
