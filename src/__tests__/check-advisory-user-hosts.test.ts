import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { buildAdvisoryOutput, buildRelatedOutput, buildUnknownOutput, registerCheckCommand } from '../commands/check.js';

/**
 * ALI-952: `align check --advisory --format codex|cursor|copilot`. One engine, three more
 * output shapes, every field name from the host's hook reference (docs/agent-hooks.md):
 *
 *   codex    Claude Code's shape verbatim: hookSpecificOutput.additionalContext, or
 *            permissionDecision:'deny' + permissionDecisionReason.
 *   cursor   preToolUse reads {permission, user_message, agent_message} and nothing else,
 *            so a NON-blocking pre-check emits nothing and postToolUse carries
 *            {additional_context} - the Gemini split.
 *   copilot  preToolUse reads {permissionDecision, permissionDecisionReason}; postToolUse
 *            carries {additionalContext}. Same split.
 */
const related = [{ id: 'd1', title: 'Chose Postgres', summary: 'JSONB' }];
const critical = [{ decision_id: 'd1', title: 'Chose Postgres', severity: 'critical' as const, reason: 'no mongo', url: 'https://x' }] as never;

describe('renderForHost - codex', () => {
  it('pre: non-blocking context rides hookSpecificOutput.additionalContext', () => {
    expect(buildRelatedOutput(related, { pre: true, format: 'codex', blockOnCritical: false })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('Chose Postgres') },
    });
  });

  it('pre: a critical verdict with --block-on-critical denies with a reason', () => {
    expect(buildAdvisoryOutput(critical, { pre: true, format: 'codex', blockOnCritical: true })).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('Chose Postgres') },
    });
  });
});

describe('renderForHost - cursor', () => {
  it('pre: a non-blocking finding emits NOTHING, because preToolUse has no context channel', () => {
    expect(buildRelatedOutput(related, { pre: true, format: 'cursor', blockOnCritical: false })).toBeNull();
    expect(buildUnknownOutput({ pre: true, format: 'cursor', blockOnCritical: false })).toBeNull();
  });

  it('post: the finding rides additional_context', () => {
    expect(buildRelatedOutput(related, { pre: false, format: 'cursor', blockOnCritical: false })).toEqual({
      additional_context: expect.stringContaining('Chose Postgres'),
    });
    expect(buildUnknownOutput({ pre: false, format: 'cursor', blockOnCritical: false })).toEqual({
      additional_context: expect.stringContaining('could not check'),
    });
  });

  it('pre: a critical verdict with --block-on-critical denies, telling both the user and the agent why', () => {
    const out = buildAdvisoryOutput(critical, { pre: true, format: 'cursor', blockOnCritical: true }) as Record<string, string>;
    expect(out['permission']).toBe('deny');
    expect(out['agent_message']).toContain('Chose Postgres');
    expect(out['user_message']).toContain('Chose Postgres');
  });

  // Never after the edit has landed - the same rule every host follows.
  it('post: never denies, even with the flag and a critical conflict', () => {
    const out = buildAdvisoryOutput(critical, { pre: false, format: 'cursor', blockOnCritical: true }) as Record<string, unknown>;
    expect(out['permission']).toBeUndefined();
    expect(out['additional_context']).toEqual(expect.stringContaining('Chose Postgres'));
  });
});

describe('renderForHost - copilot', () => {
  it('pre: a non-blocking finding emits NOTHING, because preToolUse has no context channel', () => {
    expect(buildRelatedOutput(related, { pre: true, format: 'copilot', blockOnCritical: false })).toBeNull();
    expect(buildUnknownOutput({ pre: true, format: 'copilot', blockOnCritical: false })).toBeNull();
  });

  it('post: the finding rides additionalContext', () => {
    expect(buildRelatedOutput(related, { pre: false, format: 'copilot', blockOnCritical: false })).toEqual({
      additionalContext: expect.stringContaining('Chose Postgres'),
    });
  });

  it('pre: a critical verdict with --block-on-critical denies with permissionDecisionReason', () => {
    expect(buildAdvisoryOutput(critical, { pre: true, format: 'copilot', blockOnCritical: true })).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('Chose Postgres'),
    });
  });

  it('post: never denies', () => {
    const out = buildAdvisoryOutput(critical, { pre: false, format: 'copilot', blockOnCritical: true }) as Record<string, unknown>;
    expect(out['permissionDecision']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// The cwd half. A user-level hook does not run in the project: Cursor documents that
// user-level hook scripts run from ~/.cursor/. The post path reads `git diff` in
// process.cwd() and the dedup/verdict stores key on it, so runAdvisory has to move to the
// workspace the payload names before touching either.
// ---------------------------------------------------------------------------------------
const mockCheckAlignment = vi.fn();
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod') }));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('')),
  getHeadDiff: vi.fn(() => Promise.resolve('+ x')),
  getCurrentBranch: vi.fn(() => Promise.resolve('main')),
}));
const mockExistsSync = vi.fn(() => false);
vi.mock('node:fs', () => ({ existsSync: (p: string) => mockExistsSync(p), readFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })) }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })) }));
const mockReadHookPayload = vi.fn(() => Promise.resolve<unknown>(null));
vi.mock('../lib/hook-payload.js', () => ({ readHookPayload: () => mockReadHookPayload() }));
vi.mock('../lib/advisory-dedup.js', () => ({ recentlySurfaced: () => new Set<string>(), markSurfaced: vi.fn() }));

async function runAdvisory(args: string[]): Promise<void> {
  const program = new Command();
  registerCheckCommand(program);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => { throw new Error(`exit(${code})`); });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'align', 'check', '--advisory', ...args]);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

describe('runAdvisory moves to the workspace the hook payload names', () => {
  let chdir: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [] });
    chdir = vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
  });

  it('chdirs to payload.cwd when it exists', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/w/project');
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PostToolUse', cwd: '/w/project', tool_name: 'Write', tool_input: {} });
    await runAdvisory(['--format', 'cursor']);
    expect(chdir).toHaveBeenCalledWith('/w/project');
  });

  it('stays put when the payload names no cwd, or one that does not exist', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} });
    await runAdvisory(['--format', 'cursor']);
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PostToolUse', cwd: '/gone', tool_name: 'Write', tool_input: {} });
    await runAdvisory(['--format', 'cursor']);
    expect(chdir).not.toHaveBeenCalled();
  });
});
