import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod'), resolveImportEnv: vi.fn((e: string) => e ?? 'prod') }));

const mockIsGitRepo = vi.fn(() => Promise.resolve(true));
vi.mock('../lib/git.js', () => ({
  isGitRepo: () => mockIsGitRepo(),
  getStagedDiff: vi.fn(() => Promise.resolve('')),
  getHeadDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// use mongodb')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));

const mockSearchDecisions = vi.fn();
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    checkAlignment: mockCheckAlignment,
    searchDecisions: mockSearchDecisions,
  })),
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
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', confidence: 0, relevant_decisions: [{ id: 'd-1', title: 'Use PostgreSQL', summary: 's', status: 'active', similarity: 0.7 }] });

    const { exitCode, stdout } = await runCheck(['--advisory']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Use PostgreSQL');
  });

  // INVERTED deliberately. This used to assert silence on a gateway error, which is the exact
  // fail-open ALI-348/ALI-414 closed elsewhere: "could not check" was indistinguishable from
  // "nothing found". The edit still proceeds (exit 0, never blocking) - it just says so now.
  it('says "could not check" when the gateway errors, rather than failing silently', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('gateway down'));
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain('could not check');
  });

  it('exits 0 with no output and never calls the gateway outside a git repo', async () => {
    mockIsGitRepo.mockResolvedValue(false);
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(mockCheckAlignment).not.toHaveBeenCalled();
  });

  it('exits 0 with no hook JSON when nothing related is retrieved (no noise)', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', confidence: 0, relevant_decisions: [], count: 0, strategy: 'semantic' });
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});

describe('align check --advisory (PreToolUse hook mode)', () => {

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

  it('checks the PROPOSED content (not git) and emits PreToolUse additionalContext', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', confidence: 0, relevant_decisions: [{ id: 'd-1', title: 'Use PostgreSQL', summary: 's', status: 'active', similarity: 0.7 }] });
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    // checked the proposed edit content, not a git diff
    expect(mockCheckAlignment).toHaveBeenCalledWith('// switch to mongodb', 'src/db.ts', { depth: 'related' });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Use PostgreSQL');
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });



  it('reads the new_string for an Edit payload', async () => {
    mockReadHookPayload.mockResolvedValue({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'a.ts', old_string: 'postgres', new_string: 'mongodb client' },
    });
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', confidence: 0, relevant_decisions: [{ id: 'd-1', title: 'Use PostgreSQL', summary: 's', status: 'active', similarity: 0.7 }] });
    await runCheck(['--advisory']);
    expect(mockCheckAlignment).toHaveBeenCalledWith('mongodb client', 'a.ts', { depth: 'related' });
  });

  it('stays silent when the same decision was already surfaced by the sibling hook', async () => {
    mockRecentlySurfaced.mockReturnValue(new Set(['d-1']));
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', confidence: 0, relevant_decisions: [{ id: 'd-1', title: 'Use PostgreSQL', summary: 's', status: 'active', similarity: 0.7 }] });
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 with no output when retrieval finds nothing related', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', confidence: 0, relevant_decisions: [], count: 0, strategy: 'semantic' });
    const { exitCode, stdout } = await runCheck(['--advisory']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});

// End-to-end wiring per host: payload in on stdin, host-shaped bytes out on stdout, through
// the real command. The unit tests in advisory-formats.test.ts pin each host's SHAPE against
// buildAdvisoryOutput; these prove runAdvisory actually reaches the renderer and that --format
// is threaded through. They drive retrieval because that is what the hook now calls.
describe('align check --advisory --format <host> (wiring)', () => {
  const hit = {
    status: 'retrieved' as const,
    confidence: 0,
    relevant_decisions: [{ id: 'd1', title: 'Use PostgreSQL', summary: 's', similarity: 0.7 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGitRepo.mockResolvedValue(true);
    mockReadHookPayload.mockReset();
    mockRecentlySurfaced.mockReset();
    mockRecentlySurfaced.mockReturnValue(new Set<string>());
    mockCheckAlignment.mockResolvedValue(hit);
  });

  it('emits pi {context} on a tool_call, so the extension can replay it non-blockingly', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { content: 'use mongo' } });
    const { exitCode, stdout } = await runCheck(['--advisory', '--format', 'pi']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.block).toBeUndefined();
    expect(parsed.context).toContain('Use PostgreSQL');
  });

  // Retrieval never blocks, whatever the flag says: only an adjudicated critical may deny,
  // and the hook no longer adjudicates.
  it('does not block on --block-on-critical, because retrieval is not a verdict', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { content: 'use mongo' } });
    const { stdout } = await runCheck(['--advisory', '--format', 'pi', '--block-on-critical']);
    expect(JSON.parse(stdout).block).toBeUndefined();
  });

  it('stays silent on a Gemini BeforeTool, which has no context channel', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { content: 'use mongo' } });
    const { exitCode, stdout } = await runCheck(['--advisory', '--format', 'gemini']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('emits Gemini additionalContext on an AfterTool', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PostToolUse', tool_name: 'write_file', tool_input: { content: 'x' } });
    const { stdout } = await runCheck(['--advisory', '--format', 'gemini']);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('Use PostgreSQL');
  });

  it('emits plain prose (not JSON) for --format text', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { new_string: 'x' } });
    const { stdout } = await runCheck(['--advisory', '--format', 'text']);
    expect(stdout).toContain('Use PostgreSQL');
    expect(() => JSON.parse(stdout)).toThrow();
  });
});

describe('align check --advisory (fast tier)', () => {
  const hit = {
    status: 'retrieved' as const,
    confidence: 0,
    relevant_decisions: [
      { id: 'd1', title: 'Use PostgreSQL, not Mongo', summary: 'Store decisions in Postgres', similarity: 0.71 },
      { id: 'd2', title: 'One writer per fact', summary: 'Avoid duplicate sources of truth', similarity: 0.55 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGitRepo.mockResolvedValue(true);
    mockReadHookPayload.mockReset();
    mockReadHookPayload.mockResolvedValue({
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'switch to mongo' },
    });
    mockRecentlySurfaced.mockReset();
    mockRecentlySurfaced.mockReturnValue(new Set<string>());
  });

  it('never calls the ~11s adjudication path from the hook', async () => {
    mockCheckAlignment.mockResolvedValue(hit);
    await runCheck(['--advisory', '--format', 'text']);
    // Retrieval only: the depth flag is what keeps this off the ~11s adjudication path.
    expect(mockCheckAlignment).toHaveBeenCalledWith(expect.any(String), expect.any(String), { depth: 'related' });
  });

  it('surfaces retrieved decisions as RELATED, never as a conflict', async () => {
    mockCheckAlignment.mockResolvedValue(hit);
    const { exitCode, stdout } = await runCheck(['--advisory', '--format', 'text']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Use PostgreSQL, not Mongo');
    // Cosine encodes topic, not opposition - the agreeing pair scored HIGHER than the
    // contradicting one (ALI-410). Claiming a conflict from retrieval would be worse than
    // saying nothing.
    expect(stdout.toLowerCase()).not.toContain('conflict');
  });

  it('stays silent when retrieval genuinely finds nothing', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', confidence: 0, relevant_decisions: [], count: 0, strategy: 'semantic' });
    const { exitCode, stdout } = await runCheck(['--advisory', '--format', 'text']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ALI-414 / ALI-348: "could not check" must never be indistinguishable from "nothing found".
  it('says so explicitly when retrieval fails', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('gateway down'));
    const { exitCode, stdout } = await runCheck(['--advisory', '--format', 'text']);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain('could not check');
  });

  it('says so explicitly when retrieval times out', async () => {
    mockCheckAlignment.mockImplementation(() => new Promise(() => {}));
    const { exitCode, stdout } = await runCheck(['--advisory', '--format', 'text']);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain('could not check');
  }, 15000);

  it('never blocks the edit, even on the unknown path', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('gateway down'));
    const { stdout } = await runCheck(['--advisory', '--format', 'pi', '--block-on-critical']);
    expect(JSON.parse(stdout).block).toBeUndefined();
  });
});

/**
 * The --help text is a customer-facing promise. It said "deny an edit on a CRITICAL
 * conflict" while the flag was inert; then it said "no effect" while ALI-570 was pending;
 * now the flag is real and the description must carry BOTH halves of the new contract:
 * what it does (background adjudication, deny a retry) and what it costs (in local mode,
 * adjudication calls your own AI provider - the egress that is off by default since #143).
 *
 * Read from the commander Option object, not the source text, so a comment containing the
 * banned words cannot satisfy or break it.
 */
describe('--block-on-critical help text carries the deferred-adjudication contract', () => {
  function optionDescription(): string {
    const program = new Command();
    registerCheckCommand(program);
    const check = program.commands.find(c => c.name() === 'check');
    if (!check) throw new Error('check command not registered - the fixture never built it');
    const opt = check.options.find(o => o.long === '--block-on-critical');
    if (!opt) throw new Error('--block-on-critical not declared - removing it breaks committed hooks');
    return opt.description;
  }

  it('no longer claims to be inert', () => {
    expect(optionDescription()).not.toMatch(/no effect|reserved/i);
  });

  it('says what it does: background adjudication, denying a retry on a critical conflict', () => {
    expect(optionDescription()).toMatch(/background/i);
    expect(optionDescription()).toMatch(/retry/i);
    expect(optionDescription()).toMatch(/critical/i);
  });

  it('names the cost, because opting in re-enables provider egress in local mode', () => {
    expect(optionDescription()).toMatch(/your own AI provider/i);
  });
});
