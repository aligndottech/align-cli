/**
 * ALI-570: deferred adjudication for the advisory hook - buildAdvisoryOutput's runtime caller.
 *
 * The hook stays retrieval-only inside its window. Under `--block-on-critical` it ALSO
 * spawns a detached adjudicator for the proposed change and exits; the adjudicator runs the
 * full check after the hook window and records a verdict; the next PreToolUse proposing the
 * SAME change is answered from that verdict - a critical conflict as a Claude Code
 * `permissionDecision: 'deny'`, anything less as context.
 *
 * "The same change" means the tool, the target file and the text - not the text alone. A
 * verdict keyed on text would let one deny answer an Edit to another file that happens to
 * share a new_string, so the lookup ARGUMENTS are asserted here, not just its return value.
 *
 * Everything stays opt-in behind the flag, because in local mode adjudication is the
 * pipeline's only provider egress (#143 turned that off by default, deliberately): no flag,
 * no store lookup, no spawn, no provider call. That property is pinned here, not described.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import type * as AdvisoryVerdictModule from '../lib/advisory-verdict.js';
import { contentHashOf, MAX_CONCURRENT_ADJUDICATIONS, type StoredVerdict } from '../lib/advisory-verdict.js';

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

const mockMarkSurfaced = vi.fn();
vi.mock('../lib/advisory-dedup.js', () => ({
  recentlySurfaced: vi.fn(() => new Set<string>()),
  markSurfaced: (...a: unknown[]) => mockMarkSurfaced(...a),
}));

const mockBlockableVerdictFor = vi.fn<(...args: unknown[]) => StoredVerdict | null>(() => null);
const mockAdjudicationExistsFor = vi.fn(() => false);
const mockMarkAdjudicationPending = vi.fn();
const mockRecordVerdict = vi.fn();
const mockInFlight = vi.fn(() => 0);
const PAYLOAD_PATH = '/tmp/align-test/adjudicate-abc.json';
vi.mock('../lib/advisory-verdict.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AdvisoryVerdictModule>()),
  blockableVerdictFor: (...a: unknown[]) => mockBlockableVerdictFor(...a),
  adjudicationExistsFor: () => mockAdjudicationExistsFor(),
  markAdjudicationPending: (...a: unknown[]) => mockMarkAdjudicationPending(...a),
  recordVerdict: (...a: unknown[]) => mockRecordVerdict(...a),
  inFlightAdjudications: () => mockInFlight(),
  adjudicationPayloadPath: () => PAYLOAD_PATH,
}));

const mockUnref = vi.fn();
const mockOn = vi.fn();
const mockSpawn = vi.fn(() => ({ unref: mockUnref, on: mockOn }));
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

/** Mirrors identityHashOf in check.ts: tool, file, replaced text, new text, NUL-joined. */
function identityHash(toolName: string, filePath: string, oldString: string, text: string): string {
  return contentHashOf([toolName, filePath, oldString, text].join('\0'));
}
const PRE_HASH = identityHash('Write', 'src/db.ts', '', PROPOSED);

const CRITICAL_VERDICT: StoredVerdict = {
  ts: Date.now(),
  filePath: 'src/db.ts',
  contentHash: PRE_HASH,
  adjudicated: true,
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
  mockInFlight.mockReturnValue(0);
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

  /**
   * The feature's core safety claim, and the one nothing used to pin: the lookup is keyed on
   * the CHANGE, so a deny cannot land on an unrelated later edit to the same file. Asserting
   * only the return value leaves the key free - swapping the hash for one derived from the
   * file path passed every test in this file.
   */
  it('looks the verdict up by change identity AND target file, never by file alone', async () => {
    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockBlockableVerdictFor).toHaveBeenCalledWith(process.cwd(), 'prod', PRE_HASH, 'src/db.ts');
  });

  it('the same text in a DIFFERENT file is a different key', async () => {
    mockReadHookPayload.mockResolvedValue({
      ...PRE_PAYLOAD,
      tool_input: { file_path: 'docs/scratch.md', content: PROPOSED },
    });

    await runCheck(['--advisory', '--block-on-critical']);

    const [, , hash, file] = mockBlockableVerdictFor.mock.calls[0] as [string, string, string, string];
    expect(file).toBe('docs/scratch.md');
    expect(hash).not.toBe(PRE_HASH);
    expect(hash).toBe(identityHash('Write', 'docs/scratch.md', '', PROPOSED));
  });

  it('an Edit is a different key from a Write of the same text', async () => {
    mockReadHookPayload.mockResolvedValue({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/db.ts', old_string: 'postgres', new_string: PROPOSED },
    });

    await runCheck(['--advisory', '--block-on-critical']);

    const [, , hash] = mockBlockableVerdictFor.mock.calls[0] as [string, string, string, string];
    expect(hash).toBe(identityHash('Edit', 'src/db.ts', 'postgres', PROPOSED));
    expect(hash).not.toBe(PRE_HASH);
  });

  it('records the surfaced decisions, so the sibling POST hook does not repeat them', async () => {
    mockBlockableVerdictFor.mockReturnValue(CRITICAL_VERDICT);

    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockMarkSurfaced).toHaveBeenCalledWith(process.cwd(), ['d-1']);
  });

  /**
   * gemini's BeforeTool reads decision/reason and has no additionalContext channel, so
   * buildAdvisoryOutput returns null for a non-blocking pre-check there. Exiting on that null
   * would spend the verdict on silence AND skip retrieval - a silent capability loss on one
   * host only. The fall-through is what lets AfterTool still carry the context.
   */
  it('falls through to retrieval when the host has no pre-edit context channel', async () => {
    mockBlockableVerdictFor.mockReturnValue({
      ...CRITICAL_VERDICT,
      conflicts: [{ ...CRITICAL_VERDICT.conflicts[0]!, severity: 'warning' }],
    });

    await runCheck(['--advisory', '--block-on-critical', '--format', 'gemini']);

    expect(mockCheckAlignment).toHaveBeenCalled();
  });

  it('still DENIES on gemini when the verdict is critical', async () => {
    mockBlockableVerdictFor.mockReturnValue(CRITICAL_VERDICT);

    const { stdout } = await runCheck(['--advisory', '--block-on-critical', '--format', 'gemini']);

    expect(stdout).toContain('"decision":"deny"');
    expect(mockCheckAlignment).not.toHaveBeenCalled();
  });
});

describe('spawning the deferred adjudicator', () => {
  it('spawns detached for the proposed content when retrieval found something', async () => {
    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    // The WHOLE argv, not just a token in it: dropping the payload path (so the child eats
    // `--env` as the filename) or hardcoding argv[0] both ship a feature that never fires,
    // and both are invisible to a `toContain`.
    expect(args).toEqual([
      process.argv[1],
      'check',
      '--adjudicate-deferred',
      PAYLOAD_PATH,
      '--env',
      'prod',
    ]);
    // toEqual, not toMatchObject: an added `shell: true` would make the payload path a
    // command-injection surface and toMatchObject cannot see an added key.
    expect(opts).toEqual({ detached: true, stdio: 'ignore' });
    expect(mockUnref).toHaveBeenCalledTimes(1);
    // spawn reports failure asynchronously, so the try/catch cannot see it. Without a
    // listener an ENOENT/EMFILE takes the hook down with it.
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockMarkAdjudicationPending).toHaveBeenCalledWith(process.cwd(), 'prod', PRE_HASH);
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

  /**
   * The hash dedup only catches a re-proposal of the SAME change, which is the rare case: an
   * agent iterating produces different content every time. Without a cap that is one detached
   * process and one full adjudication per edit, so the cap is what actually bounds the cost.
   */
  it('never spawns while the in-flight cap is already reached', async () => {
    mockInFlight.mockReturnValue(MAX_CONCURRENT_ADJUDICATIONS);

    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockSpawn).not.toHaveBeenCalled();
    // Losing a verdict is the cost; the edit still goes through with its context.
    expect(mockMarkAdjudicationPending).not.toHaveBeenCalled();
  });

  it('spawns while under the cap', async () => {
    mockInFlight.mockReturnValue(MAX_CONCURRENT_ADJUDICATIONS - 1);

    await runCheck(['--advisory', '--block-on-critical']);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
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
  const IDENTITY = { toolName: 'Write', filePath: 'src/db.ts', oldString: '', text: PROPOSED };
  const PAYLOAD = {
    identity: IDENTITY,
    context: 'src/db.ts',
    cwd: '/repo',
    contentHash: PRE_HASH,
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
    expect(mockCheckAlignment).toHaveBeenCalledWith(PROPOSED, 'src/db.ts', {});
    expect(mockRecordVerdict).toHaveBeenCalledTimes(1);
    const [cwd, , verdict] = mockRecordVerdict.mock.calls[0] as [string, string, StoredVerdict];
    expect(cwd).toBe('/repo');
    expect(verdict.contentHash).toBe(PRE_HASH);
    expect(verdict.filePath).toBe('src/db.ts');
    expect(verdict.adjudicated).toBe(true);
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

    const [, , verdict] = mockRecordVerdict.mock.calls[0] as [string, string, StoredVerdict];
    expect(verdict.conflicts).toEqual([]);
    // A clean result IS a judgement, so it earns the full verdict lifetime.
    expect(verdict.adjudicated).toBe(true);
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

    const [, , verdict] = mockRecordVerdict.mock.calls[0] as [string, string, StoredVerdict];
    expect(verdict.conflicts).toEqual([]);
    // And it is recorded as NOT adjudicated, so it expires on the short marker TTL instead
    // of masquerading as "adjudicated clean" for 15 minutes.
    expect(verdict.adjudicated).toBe(false);
  });

  it('exits 0 and records nothing when the check itself throws', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('gateway down'));

    const { exitCode } = await runCheck(['--adjudicate-deferred', PAYLOAD_FILE]);

    expect(exitCode).toBe(0);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });

  /**
   * The payload crosses a FILE, so "this hash names this text" is a premise, not a
   * guarantee. Without the re-derivation a swapped payload binds an arbitrary verdict to an
   * arbitrary change - which is the one logic route to a deny landing on content nobody
   * judged. Deleting the check reddened nothing until this test existed.
   */
  it('refuses a payload whose hash does not match its own identity', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ ...PAYLOAD, contentHash: 'not-the-hash-of-this' }));
    mockCheckAlignment.mockResolvedValue({
      status: 'conflicting',
      confidence: 0.9,
      relevant_decisions: [],
      conflicts: [{ decision_id: 'd-1', title: 'Use Postgres', reason: 'r', severity: 'critical' }],
    });

    const { exitCode } = await runCheck(['--adjudicate-deferred', PAYLOAD_FILE]);

    expect(exitCode).toBe(0);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
    // Positive control: it never even asked the gateway, so the refusal is the guard and not
    // a failure further down. Without this, "no verdict" is equally true of a thrown check.
    expect(mockCheckAlignment).not.toHaveBeenCalled();
  });

  it('refuses a payload with no identity at all', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ context: 'src/db.ts', cwd: '/repo', contentHash: PRE_HASH }));

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
