/**
 * `retrieved` is the third member of the family check.ts's ALI-414 comments are about:
 * decisions came back, nothing adjudicated them. It is not a conflict and it is emphatically
 * not "nothing found", because relevant_decisions is populated - and with it missing from the
 * status branches it fell into the no-context `else` and printed "No related decisions found"
 * while exiting 0. That is the same defect ALI-348 fixed for `unknown`, on the value the
 * cloud client already declares and the local client now returns for `depth:'related'`.
 *
 * Harness copied from check-unknown.test.ts on purpose: same subject, same seams.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({
  resolveEnv: vi.fn((e: string) => e ?? 'prod'),
  resolveImportEnv: vi.fn((e: string) => e ?? 'prod'),
}));

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

const RETRIEVED_RESULT = {
  status: 'retrieved',
  confidence: 0.7,
  relevant_decisions: [
    { id: 'd-1', title: 'Standardise on PostgreSQL', summary: 'ACID compliance', similarity: 0.7, url: 'https://slack.com/x' },
  ],
  conflicts: [],
  message: 'Found 1 related decision(s) - retrieval only, not adjudicated.',
};

async function runCheck(args: string[]): Promise<{ exitCode: number | undefined; stdout: string; console: string }> {
  const program = new Command();
  registerCheckCommand(program);
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

describe('align check on a "retrieved" result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAlignment.mockResolvedValue(RETRIEVED_RESULT);
  });

  it('does not mislabel it as "no related decisions found"', async () => {
    const { console: out } = await runCheck([]);
    expect(out).not.toMatch(/No related decisions found/);
  });

  // Exit 2, like `unknown`: nothing was verified, so a 0 would read as a clean check to the
  // CI job or agent branching on it.
  it('exits 2 rather than 0, because nothing was adjudicated', async () => {
    const { exitCode } = await runCheck([]);
    expect(exitCode).toBe(2);
  });

  it('names the decisions it retrieved, and says they were not adjudicated', async () => {
    const { console: out } = await runCheck([]);
    expect(out).toMatch(/Standardise on PostgreSQL/);
    expect(out).toMatch(/not adjudicated/i);
  });

  it('never prints a green "Aligned" header', async () => {
    const { console: out } = await runCheck([]);
    expect(out).not.toMatch(/Aligned with decision graph/);
  });

  it('exits 2 in --ci mode and still writes the result JSON to stdout', async () => {
    const { exitCode, stdout } = await runCheck(['--ci']);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.split('\n')[0] as string)).toMatchObject({ status: 'retrieved' });
  });

  // The boundary, so the assertions above cannot be satisfied by treating every status as
  // unadjudicated: a genuinely empty graph still reports empty, and does NOT exit 2.
  // `toBeUndefined` rather than `toBe(0)` because this path calls no process.exit at all - it
  // returns and the process ends 0 on its own, so asserting an explicit 0 was asserting a
  // mechanism that does not exist.
  it('still reports an empty graph as "no related decisions found", without exiting 2', async () => {
    mockCheckAlignment.mockResolvedValue({
      status: 'no-context',
      confidence: 0,
      relevant_decisions: [],
      conflicts: [],
      message: 'No related decisions found in your local graph.',
    });
    const { console: out, exitCode } = await runCheck([]);
    expect(out).toMatch(/No related decisions found/);
    expect(exitCode).toBeUndefined();
  });
});
