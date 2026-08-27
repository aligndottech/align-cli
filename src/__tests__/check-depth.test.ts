/**
 * `align check --depth <related|full|exhaustive>` - how deep an answer to request.
 *
 * `exhaustive` exists for strict CI gates (ALI-708): a caller running
 * `fail-on: conflict-or-unknown` has declared that `unknown` fails its build, and the
 * gateway's similarity cost gate answers `unknown/not_adjudicated` - "we chose not to
 * look, to save one LLM call" - for exactly the low-similarity diffs a strict gate most
 * needs examined. `--depth exhaustive` tells the gateway the caller will pay for the
 * verdict. Measured on align-stack#1878: 4 of 5 required-gate runs failed this way.
 *
 * An invalid value is a loud error, never a silent fall-through to the default: a typo'd
 * depth that quietly became `full` would reintroduce the exact silent skip the flag
 * exists to remove.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();
const mockGetBaseDiff = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod'), resolveImportEnv: vi.fn((e: string) => e ?? 'prod') }));

vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('')),
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getBaseDiff: (...a: unknown[]) => mockGetBaseDiff(...a),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })),
}));

const PR_DIFF = 'diff --git a/db.ts b/db.ts\n+// switch to mongodb';
const EXIT_UNKNOWN = 2;

async function runCheck(args: string[]): Promise<{ exits: unknown[]; stdout: string }> {
  const program = new Command();
  registerCheckCommand(program);
  const exits: unknown[] = [];
  let stdout = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: unknown) => {
    exits.push(code);
    throw new Error('__exit__');
  }) as never);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    /* the exit spy throws to stop execution */
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return { exits, stdout };
}

describe('align check --depth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBaseDiff.mockResolvedValue(PR_DIFF);
    mockCheckAlignment.mockResolvedValue({
      status: 'aligned',
      confidence: 0.9,
      relevant_decisions: [],
      message: 'ok',
    });
  });

  it('forwards exhaustive to the gateway', async () => {
    await runCheck(['--ci', '--base', 'origin/main', '--depth', 'exhaustive']);

    expect(mockCheckAlignment).toHaveBeenCalledWith(
      PR_DIFF,
      'feat/test',
      expect.objectContaining({ depth: 'exhaustive' }),
    );
  });

  // Second example: an absent flag reaches the client as depth undefined; the KEY-level
  // absence on the wire (so the gateway default stays the single writer) is the client's
  // job, pinned by gateway-client.test.ts "omits the depth key entirely".
  it('sends no depth value when the flag is absent', async () => {
    await runCheck(['--ci', '--base', 'origin/main']);

    // Positive control first: the check really ran, so the absence below is not an
    // artefact of nothing having been called.
    expect(mockCheckAlignment).toHaveBeenCalledTimes(1);
    expect(mockCheckAlignment.mock.calls[0][2]?.depth).toBeUndefined();
  });

  it('rejects an invalid depth loudly in --ci, and never calls the gateway', async () => {
    const { exits, stdout } = await runCheck(['--ci', '--base', 'origin/main', '--depth', 'exhaustve']);

    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(exits[0]).toBe(EXIT_UNKNOWN);
    const line = JSON.parse(stdout.trim().split('\n').at(-1) as string);
    expect(line.status).toBe('error');
    expect(line.reason).toBe('invalid_depth');
    expect(line.message).toMatch(/depth/i);
  });

  it('rejects an invalid depth with the could-not-check code outside --ci too', async () => {
    // Exit 1 is the conflict code (decide.sh's header documents the fabricated-finding
    // confusion), so a usage error must exit EXIT_UNKNOWN on the human path as well.
    const { exits } = await runCheck(['--base', 'origin/main', '--depth', 'exhaustve']);

    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(exits[0]).toBe(EXIT_UNKNOWN);
  });

  it('rejects an invalid depth even in --advisory mode', async () => {
    // The validation sits ABOVE the advisory early-return: advisory ignores a VALID depth
    // by design (it is retrieval-only), but a typo must be loud on every path or it
    // silently becomes the default - the exact skip the flag exists to remove.
    const { exits } = await runCheck(['--advisory', '--depth', 'exhaustve']);

    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(exits[0]).toBe(EXIT_UNKNOWN);
  });
});
