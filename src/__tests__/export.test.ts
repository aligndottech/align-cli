import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerExportCommand } from '../commands/export.js';

const mockListDecisions = vi.fn();
const mockSearchDecisions = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({
      gatewayUrl: 'http://test',
      authToken: 'tok',
      tenantId: 'tid',
      mode: 'auth',
    })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({
  resolveEnv: vi.fn((e: string) => e ?? 'prod'),
}));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    listDecisions: mockListDecisions,
    searchDecisions: mockSearchDecisions,
  })),
}));

const output: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  output.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
});

describe('align export', () => {
  it('lists all decisions as brief when no topic given', async () => {
    mockListDecisions.mockResolvedValue([
      { id: 'd-1', title: 'Use PostgreSQL', summary: 'Chose Postgres for ACID compliance', platform: 'slack', status: 'active', created_at: '2026-01-01T00:00:00Z' },
      { id: 'd-2', title: 'Use Redis for caching', summary: 'Low latency requirements', platform: 'jira', status: 'active', created_at: '2026-02-01T00:00:00Z' },
    ]);

    const program = new Command();
    registerExportCommand(program);
    await program.parseAsync(['node', 'align', 'export']);

    expect(mockListDecisions).toHaveBeenCalled();
    expect(output.some(l => l.includes('Use PostgreSQL'))).toBe(true);
    expect(output.some(l => l.includes('Use Redis for caching'))).toBe(true);
  });

  it('searches decisions by topic when topic argument given', async () => {
    mockSearchDecisions.mockResolvedValue({
      results: [{ id: 'd-1', title: 'Use PostgreSQL', summary: 'Postgres for ACID', status: 'active', similarity: 0.95 }],
      count: 1,
      strategy: 'semantic',
    });

    const program = new Command();
    registerExportCommand(program);
    await program.parseAsync(['node', 'align', 'export', 'database']);

    expect(mockSearchDecisions).toHaveBeenCalledWith('database', expect.any(Number));
    expect(output.some(l => l.includes('Use PostgreSQL'))).toBe(true);
  });

  it('outputs json when --format=json', async () => {
    mockListDecisions.mockResolvedValue([
      { id: 'd-1', title: 'Use PostgreSQL', summary: 'ACID compliance', platform: 'slack', status: 'active', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const stdoutOutput: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { stdoutOutput.push(String(s)); return true; });

    const program = new Command();
    registerExportCommand(program);
    await program.parseAsync(['node', 'align', 'export', '--format', 'json']);

    const allOutput = stdoutOutput.join('');
    const parsed = JSON.parse(allOutput);
    expect(Array.isArray(parsed.decisions)).toBe(true);
    expect(parsed.decisions[0].title).toBe('Use PostgreSQL');
  });

  it('shows no decisions message when graph is empty', async () => {
    mockListDecisions.mockResolvedValue([]);

    const program = new Command();
    registerExportCommand(program);
    await program.parseAsync(['node', 'align', 'export']);

    expect(output.some(l => l.includes('No decisions'))).toBe(true);
  });
});
