import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod') }));

const mockIsGitRepo = vi.fn(() => Promise.resolve(true));
vi.mock('../lib/git.js', () => ({
  isGitRepo: () => mockIsGitRepo(),
  getStagedDiff: vi.fn(() => Promise.resolve('')),
  getHeadDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// use mongodb')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })),
}));

async function runCheck(args: string[]): Promise<{ exitCode: number | undefined; stdout: string }> {
  const program = new Command();
  registerCheckCommand(program);
  let exitCode: number | undefined;
  let stdout = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit(${code})`);
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return { exitCode, stdout };
}

describe('align check --advisory (PostToolUse hook mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGitRepo.mockResolvedValue(true);
  });

  it('emits hookSpecificOutput.additionalContext JSON and exits 0 on conflict', async () => {
    mockCheckAlignment.mockResolvedValue({
      status: 'conflicting',
      confidence: 0.9,
      relevant_decisions: [],
      conflicts: [
        { decision_id: 'd-1', title: 'Use PostgreSQL', reason: 'Code uses MongoDB', severity: 'critical', summary: 'Postgres for ACID' },
      ],
      message: 'Conflict detected',
    });

    const { exitCode, stdout } = await runCheck(['--advisory']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Use PostgreSQL');
  });

  it('exits 0 with no output when the gateway errors (fail-open)', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('gateway down'));
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 with no output and never calls the gateway outside a git repo', async () => {
    mockIsGitRepo.mockResolvedValue(false);
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(mockCheckAlignment).not.toHaveBeenCalled();
  });

  it('exits 0 with no hook JSON when the change is aligned (no noise)', async () => {
    mockCheckAlignment.mockResolvedValue({
      status: 'aligned', confidence: 0.9, relevant_decisions: [], message: 'ok',
    });
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});
