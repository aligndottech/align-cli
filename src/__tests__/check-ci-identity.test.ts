/**
 * `align check` CI identity from the environment (ALI-761 phase 2).
 *
 * The align-check action exports ALIGN_PLATFORM / ALIGN_SUBJECT_KEY / ALIGN_HEAD_SHA; the
 * check command forwards them to the gateway so its conflict events are attributable and
 * joinable to the PR. Environment rather than argv, deliberately: a new flag against an
 * older pinned CLI exits 1 with no JSON, which decide.sh reads as incomplete and a
 * required gate freezes every merge (align-stack ci.yaml records that failure mode). Env
 * vars an older CLI ignores decouple the action bump from the CLI publish.
 *
 * Validation is fail-soft by design: the gateway 400s the whole check on a malformed
 * head_sha, and a broken attribution field must cost the attribution, never the verdict.
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
const SHA = 'f'.repeat(40);

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

describe('align check CI identity from env', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The precondition is "these are NOT set", and the runner's own environment is a GitHub
    // Actions job - so unset them explicitly rather than inheriting whatever CI exports
    // (tdd.md: the environment is an input; stubEnv(k, undefined) deletes and restores).
    vi.stubEnv('ALIGN_PLATFORM', undefined);
    vi.stubEnv('ALIGN_SUBJECT_KEY', undefined);
    vi.stubEnv('ALIGN_HEAD_SHA', undefined);
    mockGetBaseDiff.mockResolvedValue(PR_DIFF);
    mockCheckAlignment.mockResolvedValue({
      status: 'aligned',
      confidence: 0.9,
      relevant_decisions: [],
      message: 'ok',
    });
  });

  it('forwards platform, subject key and head sha when the action exported them', async () => {
    vi.stubEnv('ALIGN_PLATFORM', 'github-actions');
    vi.stubEnv('ALIGN_SUBJECT_KEY', 'github:aligndottech/align-stack#1950');
    vi.stubEnv('ALIGN_HEAD_SHA', SHA);

    await runCheck(['--ci', '--base', 'origin/main']);

    expect(mockCheckAlignment).toHaveBeenCalledWith(
      PR_DIFF,
      'feat/test',
      expect.objectContaining({
        platform: 'github-actions',
        subjectKey: 'github:aligndottech/align-stack#1950',
        headSha: SHA,
      }),
    );
  });

  it('sends none of them when the env is clean - an older action changes nothing', async () => {
    await runCheck(['--ci', '--base', 'origin/main']);

    expect(mockCheckAlignment).toHaveBeenCalledTimes(1); // positive control
    const opts = mockCheckAlignment.mock.calls[0][2] ?? {};
    expect(opts.platform).toBeUndefined();
    expect(opts.subjectKey).toBeUndefined();
    expect(opts.headSha).toBeUndefined();
  });

  it('drops a malformed head sha but keeps the rest - attribution must never cost the verdict', async () => {
    vi.stubEnv('ALIGN_PLATFORM', 'github-actions');
    vi.stubEnv('ALIGN_SUBJECT_KEY', 'github:aligndottech/align-stack#1950');
    vi.stubEnv('ALIGN_HEAD_SHA', 'refs/pull/9/merge');

    await runCheck(['--ci', '--base', 'origin/main']);

    const opts = mockCheckAlignment.mock.calls[0][2] ?? {};
    expect(opts.headSha).toBeUndefined();
    expect(opts.platform).toBe('github-actions');
    expect(opts.subjectKey).toBe('github:aligndottech/align-stack#1950');
  });

  it('drops a platform that cannot be a header value, keeping the rest', async () => {
    // The platform is the one field that travels as an HTTP header: undici throws at
    // Request construction on an interior newline, and that throw is rewritten into
    // "Cannot reach gateway" - the whole verdict lost to an attribution field.
    vi.stubEnv('ALIGN_PLATFORM', 'github\nactions');
    vi.stubEnv('ALIGN_SUBJECT_KEY', 'github:aligndottech/align-stack#1950');

    await runCheck(['--ci', '--base', 'origin/main']);

    const opts = mockCheckAlignment.mock.calls[0][2] ?? {};
    expect(opts.platform).toBeUndefined();
    expect(opts.subjectKey).toBe('github:aligndottech/align-stack#1950');
  });

  it('drops a non-ASCII platform - a header value above U+00FF is not a ByteString', async () => {
    vi.stubEnv('ALIGN_PLATFORM', 'github—actions');

    await runCheck(['--ci', '--base', 'origin/main']);

    expect(mockCheckAlignment).toHaveBeenCalledTimes(1); // the check itself still ran
    expect(mockCheckAlignment.mock.calls[0][2]?.platform).toBeUndefined();
  });

  it('lowercases a mixed-case sha rather than dropping it - the gateway regex is lowercase-only', async () => {
    vi.stubEnv('ALIGN_HEAD_SHA', 'ABCDEF1234567');

    await runCheck(['--ci', '--base', 'origin/main']);

    expect(mockCheckAlignment.mock.calls[0][2]?.headSha).toBe('abcdef1234567');
  });

  it('truncates an oversized subject key to the schema max instead of failing the check', async () => {
    vi.stubEnv('ALIGN_SUBJECT_KEY', `github:${'x'.repeat(300)}#1`);

    await runCheck(['--ci', '--base', 'origin/main']);

    expect(mockCheckAlignment.mock.calls[0][2]?.subjectKey).toHaveLength(200);
  });
});
