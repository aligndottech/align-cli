// ALI-414: `align check` must never print a green "Aligned" header for a check that
// did not run. `unknown` is the honest middle - and it has to be visible in the exit
// code, because an agent (or a CI job) branches on that, not on the prose.
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

vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// use mongodb')),
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })),
}));

const UNKNOWN_RESULT = {
  status: 'unknown',
  reason: 'no_llm_key',
  confidence: 0,
  relevant_decisions: [
    { id: 'd-1', title: 'Standardise on PostgreSQL', summary: 'ACID compliance', similarity: 0.7, url: 'https://slack.com/x' },
  ],
  conflicts: [],
  message: 'Could not check 1 related decision(s) - the relationship classifier did not run.',
};

async function runCheck(args: string[]): Promise<{ exitCode: number | undefined; stdout: string; console: string }> {
  const program = new Command();
  registerCheckCommand(program);
  // Record the FIRST exit code only. The spy throws instead of terminating, so the
  // command's own catch block can run and call process.exit again - a real
  // process.exit would never have come back. Same reason check.test.ts keeps an array.
  const exitCodes: number[] = [];
  let stdout = '';
  let consoleOut = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error(`exit(${code})`);
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    consoleOut += `${a.join(' ')}\n`;
  });
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
    logSpy.mockRestore();
  }
  return { exitCode: exitCodes[0], stdout, console: consoleOut };
}

describe('align check on an "unknown" result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAlignment.mockResolvedValue(UNKNOWN_RESULT);
  });

  // Exit 2, not 1, so a script can tell "we found a conflict" from "we could not
  // look" - two states that call for different responses.
  it('exits 2 and never prints a green "Aligned" header', async () => {
    const { exitCode, console: out } = await runCheck([]);
    expect(exitCode).toBe(2);
    expect(out).not.toMatch(/Aligned with decision graph/);
  });

  // The decisions that could NOT be checked are the whole point of showing anything:
  // a bare "could not check" gives the human nothing to review.
  it('shows what could not be checked, and says it is not a pass', async () => {
    const { console: out } = await runCheck([]);
    expect(out).toMatch(/Standardise on PostgreSQL/);
    expect(out).toMatch(/could not|not a pass/i);
  });

  // The bug this also fixes: a cloud gateway ALREADY returns `unknown` (ALI-348), and
  // with it missing from the union it fell through to the no-context branch and was
  // reported as "No related decisions found" - a check failure labelled as a clean scan.
  it('does not mislabel a cloud "unknown" as "no related decisions found"', async () => {
    mockCheckAlignment.mockResolvedValue({ ...UNKNOWN_RESULT, reason: 'brain_timeout' });
    const { console: out, exitCode } = await runCheck([]);
    expect(out).not.toMatch(/No related decisions found/);
    expect(exitCode).toBe(2);
  });

  it('exits 2 in --ci mode and still writes the result JSON to stdout', async () => {
    const { exitCode, stdout } = await runCheck(['--ci']);
    expect(exitCode).toBe(2);
    // First line only: the throwing exit spy lets the command's catch block run on,
    // which a real terminating process.exit would not.
    expect(JSON.parse(stdout.split('\n')[0]!)).toMatchObject({ status: 'unknown', reason: 'no_llm_key' });
  });

  // --hook is the pre-commit path, contractually "only fail on critical conflicts".
  // Blocking every commit by a user who has not set an LLM key would get the hook
  // uninstalled, which costs more safety than it buys. It must still SAY something
  // though - "could not check" is not "no context", and the old code was silent.
  it('does not block a commit in --hook mode, but is not silent about it', async () => {
    const { exitCode, console: out } = await runCheck(['--hook']);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/could not|unchecked/i);
  });

  it('still exits 0 and stays quiet on a genuine "aligned"', async () => {
    mockCheckAlignment.mockResolvedValue({
      status: 'aligned', confidence: 0.7, relevant_decisions: [], conflicts: [], message: 'ok',
    });
    const { exitCode, console: out } = await runCheck([]);
    expect(exitCode).toBeUndefined(); // falls through, no explicit exit
    expect(out).toMatch(/Aligned with decision graph/);
  });
});

// The same invariant, on the path where the gateway never answers at all. `--ci` caught
// the exception and exited ZERO, two lines under a comment saying a check that could not
// run must not be indistinguishable from one that found nothing. Our own GitHub action
// survived it because decide.sh classifies on the status rather than the code, but the
// composite action's README tells every other runner "any runner can branch on the exit
// code", and the CLI's own table promises exit 2 means "could not check". Following either
// of those documented contracts turned an outage into a silent green.
describe('align check --ci when the gateway throws', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAlignment.mockRejectedValue(new Error('Gateway returned 401 for /alignment/check: unauthorized'));
  });

  it('exits 2, so a runner branching on the exit code cannot read an outage as a pass', async () => {
    const { exitCode } = await runCheck(['--ci']);
    expect(exitCode).toBe(2);
  });

  // Positive control on the assertion above: prove the failure path actually ran and
  // produced its line, rather than the exit code coming from somewhere else.
  it('still writes one parseable line naming what went wrong', async () => {
    const { stdout } = await runCheck(['--ci']);
    expect(JSON.parse(stdout.split('\n')[0]!)).toMatchObject({ status: 'error' });
    expect(stdout).toMatch(/401/);
  });
});

// The same invariant again, and the worst instance of it: outside a git repo the command
// exited 1 - the code that means "we found a conflict" - and `if (!opts.ci)` suppressed
// the message, so in the one mode where a machine is reading it said nothing at all.
// decide.sh already defends our own action against exactly this shape ("a CLI that
// crashes also exits 1 with no JSON on stdout ... reported as found a conflict"), but the
// CLI should not be producing it in the first place.
describe('align check --ci outside a git repository', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const git = await import('../lib/git.js');
    vi.mocked(git.isGitRepo).mockResolvedValue(false);
  });

  it('does not exit 1: "could not run" must not wear the conflict exit code', async () => {
    const { exitCode } = await runCheck(['--ci']);
    expect(exitCode).toBe(2);
  });

  it('says so on stdout instead of failing silently', async () => {
    const { stdout } = await runCheck(['--ci']);
    expect(JSON.parse(stdout.split('\n')[0]!)).toMatchObject({ status: 'error' });
    expect(stdout).toMatch(/git repositor/i);
  });

  // The human path keeps its red line and its exit 1. Only --ci changes.
  it('leaves the interactive path alone', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exitCode } = await runCheck([]);
    expect(exitCode).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Not in a git repository/);
    errSpy.mockRestore();
  });
});
