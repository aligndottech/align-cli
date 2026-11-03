/**
 * The advisory hook asks for a verdict (ALI-2051).
 *
 * The hook used to send `depth: 'related'` only: retrieval, no adjudication, so it could list
 * decisions and never say whether the edit opposed one. It now follows a non-empty retrieval
 * with a `depth: 'full'` request raced against a hook-wide deadline, and renders what comes back.
 *
 * Test list (each behaviour is one test below):
 *   1. A related decision was found -> a second request, depth 'full', same text, same file path.
 *   2. verdict `conflicting` -> the output names the decision and its link; the hook still exits 0.
 *   3. verdict `aligned` -> the output says it checked and found no conflict.
 *   4. the verdict does not arrive in time -> titles-only output plus "could not check ... in time";
 *      it never claims the change is aligned.
 *   5. the verdict request fails, or comes back `unknown` -> titles plus "no verdict"; never aligned.
 *   6. nothing related -> no verdict request (no extra latency or spend on a clean edit).
 *   7. local mode -> no verdict request (adjudication there is the provider egress #143 turned off).
 *   8. --block-on-critical keeps its meaning: it denies a RETRY, never the first attempt, and the
 *      verdict the hook just got is stored so that retry is answered without a second adjudication.
 *      Without the flag, a critical conflict never denies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import type * as AdvisoryVerdictModule from '../lib/advisory-verdict.js';
import { contentHashOf, type StoredVerdict } from '../lib/advisory-verdict.js';

const mockCheckAlignment = vi.fn();
let mockEnvName = 'prod';

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({
  resolveEnv: vi.fn(() => mockEnvName),
  resolveImportEnv: vi.fn(() => mockEnvName),
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

const mockRecordVerdict = vi.fn();
vi.mock('../lib/advisory-verdict.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AdvisoryVerdictModule>()),
  blockableVerdictFor: () => null,
  adjudicationExistsFor: () => false,
  markAdjudicationPending: vi.fn(),
  recordVerdict: (...a: unknown[]) => mockRecordVerdict(...a),
  inFlightAdjudications: () => 0,
  adjudicationPayloadPath: () => '/tmp/align-test/adjudicate-abc.json',
}));

const mockSpawn = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => mockSpawn(...a) }));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

const PROPOSED = 'switch the main store to mysql';
const FILE = 'src/db.ts';
const PRE_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: FILE, content: PROPOSED },
};

const RELATED = {
  status: 'retrieved',
  confidence: 0,
  relevant_decisions: [{ id: 'd-1', title: 'Use Postgres for persistence', summary: 's' }],
  conflicts: [],
};

const conflictingVerdict = (severity: 'critical' | 'warning', extra: Record<string, unknown> = {}) => ({
  status: 'conflicting',
  confidence: 0.9,
  relevant_decisions: RELATED.relevant_decisions,
  conflicts: [
    {
      decision_id: 'd-1',
      title: 'Use Postgres for persistence',
      reason: 'Reverses the datastore decision',
      severity,
      ...extra,
    },
  ],
});

/** First call (depth 'related') answers retrieval; the depth 'full' call gets `verdict`. */
function gateway(verdict: () => Promise<unknown>): void {
  mockCheckAlignment.mockImplementation((_text: string, _ctx: string, opts: { depth?: string }) =>
    opts?.depth === 'full' ? verdict() : Promise.resolve(RELATED),
  );
}

const fullCalls = (): unknown[][] =>
  mockCheckAlignment.mock.calls.filter((c) => (c[2] as { depth?: string } | undefined)?.depth === 'full');

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

/** Run the hook under fake timers and let every deadline pass, in steps so each microtask settles. */
async function runCheckPastDeadline(args: string[]): Promise<{ exitCode: number | undefined; stdout: string }> {
  const pending = runCheck(args);
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(1000);
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnvName = 'prod';
  mockReadHookPayload.mockResolvedValue(PRE_PAYLOAD);
  gateway(() => Promise.resolve(conflictingVerdict('warning')));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the hook asks for a verdict', () => {
  it('follows a non-empty retrieval with a depth "full" request for the same text and file path', async () => {
    await runCheck(['--advisory']);

    expect(mockCheckAlignment).toHaveBeenNthCalledWith(1, PROPOSED, FILE, { depth: 'related' });
    expect(mockCheckAlignment).toHaveBeenNthCalledWith(2, PROPOSED, FILE, { depth: 'full' });
  });
});

describe('a conflicting verdict', () => {
  it('names the decision and its link, says it may conflict, and still exits 0', async () => {
    gateway(() => Promise.resolve(conflictingVerdict('warning', { decision_url: 'https://app.align.tech/decisions/d-1' })));

    const { exitCode, stdout } = await runCheck(['--advisory']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('may conflict with 1 prior decision');
    expect(stdout).toContain('Use Postgres for persistence');
    expect(stdout).toContain('https://app.align.tech/decisions/d-1');
    expect(stdout).not.toContain('"permissionDecision":"deny"');
  });

  it('a critical conflict does not deny without --block-on-critical', async () => {
    gateway(() => Promise.resolve(conflictingVerdict('critical')));

    const { exitCode, stdout } = await runCheck(['--advisory']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Use Postgres for persistence');
    expect(stdout).not.toContain('deny');
  });
});

describe('an aligned verdict', () => {
  it('says it checked and found no conflict', async () => {
    gateway(() => Promise.resolve({ status: 'aligned', confidence: 0.8, relevant_decisions: RELATED.relevant_decisions, conflicts: [] }));

    const { exitCode, stdout } = await runCheck(['--advisory']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no conflict');
    expect(stdout).not.toContain('UNVERIFIED');
    expect(stdout).not.toContain('NOT been adjudicated');
  });
});

describe('a verdict that does not arrive', () => {
  it('on timeout, degrades to the titles and says it could not check in time - never "no conflict"', async () => {
    vi.useFakeTimers();
    gateway(() => new Promise(() => {})); // the adjudication that never fits the window

    const { exitCode, stdout } = await runCheckPastDeadline(['--advisory']);

    expect(exitCode).toBe(0);
    // Positive control: the titles-only output is what degraded to, so the assertions below are
    // about THIS output and not about an empty one.
    expect(stdout).toContain('Use Postgres for persistence');
    expect(stdout).toContain('could not check this change in time');
    expect(stdout).toContain('UNVERIFIED');
    expect(stdout).not.toContain('no conflict');
    expect(stdout).not.toContain('may conflict');
  });

  it('when the request fails, degrades to the titles and says no verdict was reached', async () => {
    gateway(() => Promise.reject(new Error('gateway down')));

    const { exitCode, stdout } = await runCheck(['--advisory']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Use Postgres for persistence');
    expect(stdout).toContain('could not reach a verdict');
    expect(stdout).not.toContain('no conflict');
  });

  it('an unknown verdict is not a pass: the titles stay, flagged as unverified', async () => {
    gateway(() => Promise.resolve({ status: 'unknown', reason: 'not_adjudicated', confidence: 0, relevant_decisions: RELATED.relevant_decisions, conflicts: [] }));

    const { stdout } = await runCheck(['--advisory']);

    expect(stdout).toContain('Use Postgres for persistence');
    expect(stdout).toContain('could not reach a verdict');
    expect(stdout).toContain('UNVERIFIED');
    expect(stdout).not.toContain('no conflict');
  });
});

describe('when no verdict is requested', () => {
  it('asks nothing beyond retrieval when nothing is related', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [] });

    await runCheck(['--advisory']);

    expect(fullCalls()).toHaveLength(0);
  });

  it('asks nothing beyond retrieval in local mode - adjudication there is provider egress', async () => {
    mockEnvName = 'local';

    const { stdout } = await runCheck(['--advisory']);

    expect(mockCheckAlignment).toHaveBeenCalledTimes(1);
    expect(fullCalls()).toHaveLength(0);
    // And it still gives the titles it always gave.
    expect(stdout).toContain('Use Postgres for persistence');
  });
});

describe('--block-on-critical keeps its meaning', () => {
  const HASH = contentHashOf(['Write', FILE, '', PROPOSED].join('\0'));

  it('does not deny the first attempt on a critical verdict, but stores it so the RETRY is denied', async () => {
    gateway(() => Promise.resolve(conflictingVerdict('critical')));

    const { exitCode, stdout } = await runCheck(['--advisory', '--block-on-critical']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Use Postgres for persistence');
    expect(stdout).not.toContain('deny');
    expect(mockRecordVerdict).toHaveBeenCalledTimes(1);
    const [, env, verdict] = mockRecordVerdict.mock.calls[0] as [string, string, StoredVerdict];
    expect(env).toBe('prod');
    expect(verdict).toMatchObject({ filePath: FILE, contentHash: HASH, adjudicated: true });
    expect(verdict.conflicts[0]).toMatchObject({ decision_id: 'd-1', severity: 'critical' });
    // The verdict is in hand, so there is nothing for a background adjudicator to do.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('stores nothing without the flag - the verdict store stays opt-in', async () => {
    gateway(() => Promise.resolve(conflictingVerdict('critical')));

    await runCheck(['--advisory']);

    expect(mockRecordVerdict).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('on a timeout still spawns the background adjudicator, as before', async () => {
    vi.useFakeTimers();
    gateway(() => new Promise(() => {}));

    await runCheckPastDeadline(['--advisory', '--block-on-critical']);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });
});
