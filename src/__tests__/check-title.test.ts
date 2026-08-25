/**
 * `align check --title <text>` - the decision being proposed, in words.
 *
 * The gateway adjudicates a proposed action against recorded decisions using
 * `new_decision.title` as real semantic input. Without this flag it derives that title from
 * the first 200 characters of the payload, and for a diff those are a file header and a few
 * `+` lines (align-stack#1652). In CI the PR title is sitting right there in the event.
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
const PR_TITLE = 'Raise the gateway Postgres pool to 30 connections';

async function runCheck(args: string[]): Promise<void> {
  const program = new Command();
  registerCheckCommand(program);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    /* the exit spy throws to stop execution */
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

describe('align check --title', () => {
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

  it('forwards the title to the gateway', async () => {
    await runCheck(['--ci', '--base', 'origin/main', '--title', PR_TITLE]);

    expect(mockCheckAlignment).toHaveBeenCalledWith(
      PR_DIFF,
      'feat/test',
      expect.objectContaining({ title: PR_TITLE }),
    );
  });

  // Second example: absent means absent. An older caller must keep exactly its current
  // behaviour, and the gateway's schema rejects an empty title outright.
  it('sends no title when the flag is absent', async () => {
    await runCheck(['--ci', '--base', 'origin/main']);

    // Positive control first: the check really ran against the diff, so the assertion below
    // is not passing because nothing was called.
    expect(mockCheckAlignment).toHaveBeenCalledTimes(1);
    expect(mockCheckAlignment.mock.calls[0][0]).toBe(PR_DIFF);
    expect(mockCheckAlignment.mock.calls[0][2]?.title).toBeUndefined();
  });
});
