/**
 * ALI-570: deferred adjudication for the advisory hook - buildAdvisoryOutput's runtime caller.
 *
 * The hook stays retrieval-only inside its window. Under `--block-on-critical` it ALSO
 * spawns a detached adjudicator for the proposed content and exits; the adjudicator runs the
 * full check after the hook window and records a verdict; the next PreToolUse proposing the
 * SAME content is answered from that verdict - a critical conflict as a Claude Code
 * `permissionDecision: 'deny'`, anything less as context.
 *
 * Everything stays opt-in behind the flag, because in local mode adjudication is the
 * pipeline's only provider egress (#143 turned that off by default, deliberately): no flag,
 * no store lookup, no spawn, no provider call. That property is pinned here, not described.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import type * as AdvisoryVerdictModule from '../lib/advisory-verdict.js';
import { contentHashOf, type StoredVerdict } from '../lib/advisory-verdict.js';

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
  getStagedDiff: vi.fn(() => Promise.resolve('')),
  getHeadDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// use mongodb')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));

const mockReadHookPayload = vi.fn(() => Promise.resolve<unknown>(null));
vi.mock('../lib/hook-payload.js', () => ({ readHookPayload: () => mockReadHookPayload() }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })),
}));

vi.mock('../lib/advisory-dedup.js', () => ({
  recentlySurfaced: vi.fn(() => new Set<string>()),
  markSurfaced: vi.fn(),
}));

const mockBlockableVerdictFor = vi.fn<(...args: unknown[]) => StoredVerdict | null>(() => null);
const mockAdjudicationExistsFor = vi.fn(() => false);
const mockMarkAdjudicationPending = vi.fn();
const mockRecordVerdict = vi.fn();
vi.mock('../lib/advisory-verdict.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AdvisoryVerdictModule>()),
  blockableVerdictFor: (...a: unknown[]) => mockBlockableVerdictFor(...a),
  adjudicationExistsFor: () => mockAdjudicationExistsFor(),
  markAdjudicationPending: (...a: unknown[]) => mockMarkAdjudicationPending(...a),
  recordVerdict: (...a: unknown[]) => mockRecordVerdict(...a),
}));

const mockUnref = vi.fn();
const mockSpawn = vi.fn(() => ({ unref: mockUnref }));
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => mockSpawn(...a) }));

const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
  unlinkSync: (...a: unknown[]) => mockUnlinkSync(...a),
  renameSync: vi.fn(),
}));

const PROPOSED = 'switch the main store to mysql';
const PRE_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: 'src/db.ts', content: PROPOSED },
};

const CRITICAL_VERDICT: StoredVerdict = {
  ts: Date.now(),
  filePath: 'src/db.ts',
  contentHash: contentHashOf(PROPOSED),
  conflicts: [
    {
      decision_id: 'd-1',
      title: 'Use Postgres for persistence',
      reason: 'Reverses the datastore decision',
      severity: 'critical',
    },
  ],
};

const RETRIEVED = {
  status: 'retrieved',
  confidence: 0.7,
  relevant_decisions: [{ id: 'd-1', title: 'Use Postgres for persistence', summary: 's' }],
  conflicts: [],
};

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

beforeEach(() => {
  vi.clearAllMocks();
  mockReadHookPayload.mockResolvedValue(PRE_PAYLOAD);
  mockCheckAlignment.mockResolvedValue(RETRIEVED);
  mockBlockableVerdictFor.mockReturnValue(null);
  mockAdjudicationExistsFor.mockReturnValue(false);
});

describe('the verdict answers a retry (the DoD path)', () => {
  it('denies a PreToolUse retry of critically-conflicting content, naming the decision', async () => {
    mockBlockableVerdictFor.mockReturnValue(CRITICAL_VERDICT);

    const { exitCode, stdout } = await runCheck(['--advisory', '--block-on-critical']);

    expect(exitCode).toBe(0); // advisory NEVER exits non-zero, even when denying
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain('Use Postgres for persistence');
    // The verdict IS the answer: no second retrieval, and emphatically no re-adjudication.
    expect(mockCheckAlignment).not.toHaveBeenCalled();
  });

  it('surfaces a warning-only verdict as context, never a deny', async () => {
    mockBlockableVerdictFor.mockReturnValue({
      ...CRITICAL_VERDICT,
      conflicts: [{ ...CRITICAL_VERDICT.conflicts[0]!, severity: 'warning' }],
    });

    const { stdout } = await runCheck(['--advisory', '--block-on-critical']);

    expect(stdout).toContain('Use Postgres for persistence');
    expect(stdout).not.toContain('"permissionDecision":"deny"');
    // The VERDICT answered, not retrieval: without this the assertion above is satisfied by
    // the ordinary retrieval path echoing the same title (it did, pre-implementation).
    expect(mockCheckAlignment).not.toHaveBeenCalled();
  });

  it('ignores the verdict store entirely without the flag - the subsystem is opt-in', async () => {
    mockBlockableVerdictFor.mockReturnValue(CRITICAL_VERDICT);

    const { stdout } = await runCheck(['--advisory']);

    expect(mockBlockableVerdictFor).not.toHaveBeenCalled();
    expect(stdout).not.toContain('"permissionDecision":"deny"');
  });

  it('a verdict with no conflicts short-circuits nothing - retrieval proceeds as normal', async () => {
    mockBlockableVerdictFor.mockReturnValue({ ...CRITICAL_VERDICT, conflicts: [] });

    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockCheckAlignment).toHaveBeenCalled();
  });
});

describe('spawning the deferred adjudicator', () => {
  it('spawns detached for the proposed content when retrieval found something', async () => {
    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('--adjudicate-deferred');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(mockUnref).toHaveBeenCalledTimes(1);
    expect(mockMarkAdjudicationPending).toHaveBeenCalledWith(process.cwd(), contentHashOf(PROPOSED));
    // The payload travels by file, never argv: proposed content can be any size and any shape.
    const written = mockWriteFileSync.mock.calls.map(c => String(c[1])).join('');
    expect(written).toContain(PROPOSED);
  });

  it('never spawns without the flag - in local mode adjudication is the only provider egress', async () => {
    await runCheck(['--advisory']);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockMarkAdjudicationPending).not.toHaveBeenCalled();
  });

  it('never spawns when a fresh adjudication for this content already exists', async () => {
    mockAdjudicationExistsFor.mockReturnValue(true);

    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('never spawns when retrieval found nothing - there is nothing to adjudicate', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [] });

    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('never spawns from PostToolUse - the PRE text is the only retry-matchable artefact', async () => {
    mockReadHookPayload.mockResolvedValue(null); // no payload = the POST/manual path

    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('the adjudicator itself (--adjudicate-deferred)', () => {
  const PAYLOAD_FILE = '/tmp/align-adjudicate-test.json';
  const PAYLOAD = {
    text: PROPOSED,
    context: 'src/db.ts',
    cwd: '/repo',
    filePath: 'src/db.ts',
    contentHash: contentHashOf(PROPOSED),
  };

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(JSON.stringify(PAYLOAD));
  });

  it('runs the FULL check and records the conflicts as a verdict', async () => {
    mockCheckAlignment.mockResolvedValue({
      status: 'conflicting',
      confidence: 0.9,
      relevant_decisions: [],
      conflicts: [
        { decision_id: 'd-1', title: 'Use Postgres for persistence', reason: 'Reverses it', severity: 'critical' },
      ],
    });

    const { exitCode } = await runCheck(['--adjudicate-deferred', PAYLOAD_FILE]);

    expect(exitCode).toBe(0);
    // Full adjudication: no depth option, so the gateway default applies.
    expect(mockCheckAlignment).toHaveBeenCalledWith(PROPOSED, 'src/db.ts', expect.not.objectContaining({ depth: 'related' }));
    expect(mockRecordVerdict).toHaveBeenCalledTimes(1);
    const [cwd, verdict] = mockRecordVerdict.mock.calls[0] as [string, StoredVerdict];
    expect(cwd).toBe('/repo');
    expect(verdict.contentHash).toBe(contentHashOf(PROPOSED));
    expect(verdict.filePath).toBe('src/db.ts');
    expect(verdict.conflicts[0]).toMatchObject({ title: 'Use Postgres for persistence', severity: 'critical' });
    // The payload file is transport, not state: gone after the read.
    expect(mockUnlinkSync).toHaveBeenCalledWith(PAYLOAD_FILE);
  });

  it('records an EMPTY verdict for a clean result, so the same content is not re-adjudicated', async () => {
    // Non-empty conflicts on a non-conflicting status, for the same reason as the
    // `unknown` case below: only `status === 'conflicting'` may yield a blockable verdict.
    mockCheckAlignment.mockResolvedValue({
      status: 'aligned',
      confidence: 0.8,
      relevant_decisions: [],
      conflicts: [{ decision_id: 'd-8', title: 'Not blockable from aligned', reason: 'r', severity: 'critical' }],
    });

    await runCheck(['--adjudicate-deferred', PAYLOAD_FILE]);

    const [, verdict] = mockRecordVerdict.mock.calls[0] as [string, StoredVerdict];
    expect(verdict.conflicts).toEqual([]);
  });

  /**
   * The conflicts array is deliberately NON-EMPTY here. With `conflicts: []` the assertion
   * passes whether or not the status guard exists - both produce [] - which is the
   * fixture-never-reaches-the-branch shape: injecting `result.conflicts ?? []` in place of
   * the guard reddened nothing until this fixture carried rows for the guard to reject.
   */
  it('records nothing blockable on "unknown" - could-not-check must stay fail-open', async () => {
    mockCheckAlignment.mockResolvedValue({
      status: 'unknown',
      reason: 'no_llm_key',
      confidence: 0,
      relevant_decisions: [{ id: 'd', title: 't', summary: 's' }],
      conflicts: [{ decision_id: 'd-9', title: 'Never blockable from unknown', reason: 'r', severity: 'critical' }],
    });

    await runCheck(['--adjudicate-deferred', PAYLOAD_FILE]);

    const [, verdict] = mockRecordVerdict.mock.calls[0] as [string, StoredVerdict];
    expect(verdict.conflicts).toEqual([]);
  });

  it('exits 0 and records nothing when the check itself throws', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('gateway down'));

    const { exitCode } = await runCheck(['--adjudicate-deferred', PAYLOAD_FILE]);

    expect(exitCode).toBe(0);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });

  it('exits 0 on an unreadable payload rather than erroring anything', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const { exitCode } = await runCheck(['--adjudicate-deferred', PAYLOAD_FILE]);

    expect(exitCode).toBe(0);
    expect(mockCheckAlignment).not.toHaveBeenCalled();
  });
});
