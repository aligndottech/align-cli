import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerStatusCommand } from '../commands/status.js';

const client = {
  getStats: vi.fn().mockResolvedValue({ snapshots: 142 }),
  getConflictImpact: vi.fn().mockResolvedValue({ total: 6 }),
  getLinkCounts: vi.fn().mockResolvedValue({ duplicates_count: 9, supersessions_count: 4 }),
  getReuseRate: vi.fn().mockResolvedValue({ referenced: 92, rediscovered: 35, rate: 0.72 }),
  getHealth: vi.fn().mockResolvedValue({ compositeScore: { grade: 'B' } }),
};

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod') }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => client) }));

const output: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  output.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a) => { output.push(a.join(' ')); });
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
});
