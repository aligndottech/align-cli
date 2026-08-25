/**
 * `align check --base <ref>` - the option that makes the check usable in CI at all.
 *
 * A CI checkout has a clean working tree, so `git diff --staged` and `git diff HEAD` are
 * both empty. Without a base ref the command therefore finds no diff, prints "No changes to
 * check" and exits 0 on EVERY pull request: a required gate that passes without looking at
 * anything. These tests pin that `--base` is what the CI path actually diffs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();
const mockGetBaseDiff = vi.fn();
const mockGetStagedDiff = vi.fn();
const mockGetHeadDiff = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod'), resolveImportEnv: vi.fn((e: string) => e ?? 'prod') }));

vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: (...a: unknown[]) => mockGetStagedDiff(...a),
  getHeadDiff: (...a: unknown[]) => mockGetHeadDiff(...a),
  getBaseDiff: (...a: unknown[]) => mockGetBaseDiff(...a),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })),
}));

const PR_DIFF = 'diff --git a/db.ts b/db.ts\n+// switch to mongodb';

async function runCheck(args: string[]): Promise<number | undefined> {
  const program = new Command();
  registerCheckCommand(program);
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    if (exitCode === undefined) exitCode = code;
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
  return exitCode;
}

describe('align check --base', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A clean CI checkout: nothing staged, nothing uncommitted. This is the state that
    // silently defeats the check today.
    mockGetStagedDiff.mockResolvedValue('');
    mockGetHeadDiff.mockResolvedValue('');
    mockGetBaseDiff.mockResolvedValue(PR_DIFF);
    mockCheckAlignment.mockResolvedValue({ status: 'aligned', confidence: 1, relevant_decisions: [], conflicts: [] });
  });

  it('diffs against the base ref it was given', async () => {
    await runCheck(['--ci', '--base', 'origin/main']);

    expect(mockGetBaseDiff).toHaveBeenCalledWith('origin/main');
  });

  it('sends the base diff to the gateway, not an empty working-tree diff', async () => {
    await runCheck(['--ci', '--base', 'origin/main']);

    // The third argument arrived with `--title`. Asserted exactly rather than relaxed to
    // objectContaining: if a title ever starts being sent by default, this should go red.
    expect(mockCheckAlignment).toHaveBeenCalledWith(PR_DIFF, 'feat/test', { title: undefined });
  });

  it('still reports a conflict found in the base diff', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'conflicting', confidence: 0.9, relevant_decisions: [], conflicts: [{ id: 'c1' }] });

    expect(await runCheck(['--ci', '--base', 'origin/main'])).toBe(1);
  });

  it('does NOT silently pass when the working tree is clean and a base is given', async () => {
    // The whole point. Without --base this same state exits 0 having checked nothing.
    await runCheck(['--ci', '--base', 'origin/main']);

    expect(mockCheckAlignment).toHaveBeenCalledTimes(1);
  });

  it('leaves the existing local behaviour alone when no base is given', async () => {
    // Positive control on the other branch: a developer with staged work still gets the
    // staged diff, so --base is additive rather than a change of default.
    mockGetStagedDiff.mockResolvedValue('diff --git a/local.ts b/local.ts\n+// local edit');

    await runCheck(['--ci']);

    expect(mockGetBaseDiff).not.toHaveBeenCalled();
    expect(mockCheckAlignment).toHaveBeenCalledWith(
      'diff --git a/local.ts b/local.ts\n+// local edit',
      'feat/test',
      { title: undefined }
    );
  });

  it('exits non-zero when the base ref cannot be resolved, rather than passing vacuously', async () => {
    // A typo'd base, a shallow clone with no history, a deleted branch. Treating that as
    // "no changes" would be the same silent green this option exists to remove.
    mockGetBaseDiff.mockRejectedValue(new Error("fatal: bad revision 'origin/nope...HEAD'"));

    expect(await runCheck(['--ci', '--base', 'origin/nope'])).toBe(2);
  });
});
