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

// Default: no piped hook payload -> the advisory path falls back to the git diff
// (PostToolUse behaviour). PreToolUse tests override this per test.
const mockReadHookPayload = vi.fn(() => Promise.resolve<unknown>(null));
vi.mock('../lib/hook-payload.js', () => ({ readHookPayload: () => mockReadHookPayload() }));

const mockRecentlySurfaced = vi.fn(() => new Set<string>());
const mockMarkSurfaced = vi.fn();
vi.mock('../lib/advisory-dedup.js', () => ({
  recentlySurfaced: () => mockRecentlySurfaced(),
  markSurfaced: (...args: unknown[]) => mockMarkSurfaced(...args),
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
    mockReadHookPayload.mockReset();
    mockReadHookPayload.mockResolvedValue(null);
    mockRecentlySurfaced.mockReset();
    mockRecentlySurfaced.mockReturnValue(new Set<string>());
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

describe('align check --advisory (PreToolUse hook mode)', () => {
  const writeConflict = {
    status: 'conflicting',
    confidence: 0.9,
    relevant_decisions: [],
    conflicts: [{ decision_id: 'd-1', title: 'Use PostgreSQL', reason: 'proposed code uses MongoDB', severity: 'critical', summary: 'Postgres for ACID' }],
    message: 'Conflict detected',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGitRepo.mockResolvedValue(true);
    mockRecentlySurfaced.mockReset();
    mockRecentlySurfaced.mockReturnValue(new Set<string>());
    mockReadHookPayload.mockReset();
    mockReadHookPayload.mockResolvedValue({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/db.ts', content: '// switch to mongodb' },
    });
  });

  it('checks the PROPOSED content (not git) and emits PreToolUse additionalContext on conflict', async () => {
    mockCheckAlignment.mockResolvedValue(writeConflict);
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    // checked the proposed edit content, not a git diff
    expect(mockCheckAlignment).toHaveBeenCalledWith('// switch to mongodb', 'src/db.ts');
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Use PostgreSQL');
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('denies only on a critical conflict when --block-on-critical is set', async () => {
    mockCheckAlignment.mockResolvedValue(writeConflict);
    const { exitCode, stdout } = await runCheck(['--advisory', '--block-on-critical']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Use PostgreSQL');
  });

  it('does not deny a warning-level conflict even with --block-on-critical', async () => {
    mockCheckAlignment.mockResolvedValue({
      ...writeConflict,
      conflicts: [{ decision_id: 'd-2', title: 'Prefer REST', reason: 'x', severity: 'warning' }],
    });
    const { stdout } = await runCheck(['--advisory', '--block-on-critical']);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Prefer REST');
  });

  it('reads the new_string for an Edit payload', async () => {
    mockReadHookPayload.mockResolvedValue({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'a.ts', old_string: 'postgres', new_string: 'mongodb client' },
    });
    mockCheckAlignment.mockResolvedValue(writeConflict);
    await runCheck(['--advisory']);
    expect(mockCheckAlignment).toHaveBeenCalledWith('mongodb client', 'a.ts');
  });

  it('stays silent when the same conflict was already surfaced by the sibling hook', async () => {
    mockRecentlySurfaced.mockReturnValue(new Set(['d-1']));
    mockCheckAlignment.mockResolvedValue(writeConflict);
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 with no output when the proposed edit is aligned', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'aligned', confidence: 0.9, relevant_decisions: [], message: 'ok' });
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});
