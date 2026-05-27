import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();
const mockResolveConflict = vi.fn();

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

vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// use mongodb')),
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    checkAlignment: mockCheckAlignment,
    resolveConflict: mockResolveConflict,
  })),
}));

describe('align check --resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAlignment.mockResolvedValue({
      status: 'conflicting',
      confidence: 0.9,
      relevant_decisions: [],
      conflicts: [
        {
          decision_id: 'd-1',
          title: 'Use PostgreSQL',
          reason: 'Code uses MongoDB',
          severity: 'warning',
          summary: 'We chose Postgres for ACID compliance',
        },
      ],
      message: 'Conflict detected',
    });
    mockResolveConflict.mockResolvedValue({ recorded: true, change_type: 'conflict_resolved' });
  });

  it('records a resolution when --resolve flag is passed with decision_id:type', async () => {
    const program = new Command();
    registerCheckCommand(program);

    let _exitCode: number | undefined;
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      _exitCode = code;
      throw new Error(`process.exit(${code})`);
    });

    try {
      await program.parseAsync(['node', 'align', 'check', '--resolve', 'd-1:honored']);
    } catch {
      // process.exit throws
    }

    expect(mockResolveConflict).toHaveBeenCalledWith({
      decision_id: 'd-1',
      resolution_type: 'honored',
      context: expect.stringContaining('feat/test'),
    });
  });

  it('does not call resolveConflict when --resolve is not passed', async () => {
    const program = new Command();
    registerCheckCommand(program);

    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    try {
      await program.parseAsync(['node', 'align', 'check']);
    } catch {
      // process.exit throws
    }

    expect(mockResolveConflict).not.toHaveBeenCalled();
  });

  it('still exits 1 on conflict even after recording resolution', async () => {
    const program = new Command();
    registerCheckCommand(program);

    const exitCodes: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error(`exit(${code})`);
    });

    try {
      await program.parseAsync(['node', 'align', 'check', '--resolve', 'd-1:overridden']);
    } catch {
      // process.exit throws
    }

    expect(exitCodes[0]).toBe(1);
  });
});
