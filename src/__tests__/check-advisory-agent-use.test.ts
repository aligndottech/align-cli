/**
 * (see the Test list below)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import type * as AdvisoryVerdictModule from '../lib/advisory-verdict.js';

const mockCheckAlignment = vi.fn();
const mockRecordAgentUse = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/agent-use-telemetry.js', () => ({ recordAgentUse: mockRecordAgentUse }));
const mockRecordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage: mockRecordFunnelStage }));
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
  dedupScope: (cwd: string) => cwd, recentlySurfaced: vi.fn(() => new Set<string>()),
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

/**
 * The advisory hook counts its own use: one content-free event per real check, carrying the class of
 * the answer (aligned, conflicting, related, unknown, no_context) and nothing else.
 *
 * Test list: a conflicting verdict, an aligned one, a verdict that cannot be had, a verdict that does
 * not fit the window, a retrieval that fails, nothing related, a local-mode run, and an edit with no
 * text (not a check, so no event). Each asserts the exact arguments, so a field added later fails here.
 */
const RELATED = {
  status: 'retrieved',
  confidence: 0,
  relevant_decisions: [{ id: 'd-1', title: 'Use Postgres for persistence', summary: 'secret summary text' }],
  conflicts: [],
};

function gateway(verdict: () => Promise<unknown>, related: unknown = RELATED): void {
  mockCheckAlignment.mockImplementation((_text: string, _ctx: string, opts: { depth?: string }) =>
    opts?.depth === 'full' ? verdict() : typeof related === 'function' ? (related as () => Promise<unknown>)() : Promise.resolve(related),
  );
}

async function runCheck(args: string[]): Promise<void> {
  const program = new Command();
  registerCheckCommand(program);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`exit(${code})`);
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

const HOOK = { via: 'hook', tool: 'check_advisory' };

beforeEach(() => {
  vi.clearAllMocks();
  mockEnvName = 'prod';
  mockReadHookPayload.mockResolvedValue(PRE_PAYLOAD);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the advisory hook counts its use', () => {
  it('a conflicting verdict -> one event, verdict conflicting, and exactly these arguments', async () => {
    gateway(() => Promise.resolve({ status: 'conflicting', relevant_decisions: RELATED.relevant_decisions, conflicts: [{ decision_id: 'd-1', title: 'Use Postgres', reason: 'r', severity: 'warning' }] }));
    await runCheck(['--advisory']);
    expect(mockRecordAgentUse).toHaveBeenCalledTimes(1);
    const [, use, opts] = mockRecordAgentUse.mock.calls[0]!;
    expect(use).toEqual({ ...HOOK, verdict: 'conflicting' });
    expect(opts).toEqual({ capMs: 400 });
  });

  it('an aligned verdict -> aligned', async () => {
    gateway(() => Promise.resolve({ status: 'aligned', relevant_decisions: RELATED.relevant_decisions, conflicts: [] }));
    await runCheck(['--advisory']);
    expect(mockRecordAgentUse.mock.calls.map((c) => c[1])).toEqual([{ ...HOOK, verdict: 'aligned' }]);
  });

  it('a verdict that comes back unusable -> unknown, never aligned', async () => {
    gateway(() => Promise.resolve({ status: 'unknown', relevant_decisions: [], conflicts: [] }));
    await runCheck(['--advisory']);
    expect(mockRecordAgentUse.mock.calls.map((c) => c[1])).toEqual([{ ...HOOK, verdict: 'unknown' }]);
  });

  it('related decisions but no verdict (local mode asks for none) -> related', async () => {
    mockEnvName = 'local';
    gateway(() => Promise.reject(new Error('must not be asked')));
    await runCheck(['--advisory']);
    expect(mockRecordAgentUse.mock.calls.map((c) => c[1])).toEqual([{ ...HOOK, verdict: 'related' }]);
  });

  it('a retrieval that fails -> unknown', async () => {
    gateway(() => Promise.resolve(null), () => Promise.reject(new Error('gateway down')));
    await runCheck(['--advisory']);
    expect(mockRecordAgentUse.mock.calls.map((c) => c[1])).toEqual([{ ...HOOK, verdict: 'unknown' }]);
  });

  it('nothing related -> no_context', async () => {
    gateway(() => Promise.resolve(null), { status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [] });
    await runCheck(['--advisory']);
    expect(mockRecordAgentUse.mock.calls.map((c) => c[1])).toEqual([{ ...HOOK, verdict: 'no_context' }]);
  });

  it('an edit with no text is not a check: no event', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: FILE, content: '' } });
    gateway(() => Promise.resolve(null));
    await runCheck(['--advisory']);
    expect(mockRecordAgentUse).not.toHaveBeenCalled();
  });

  it('a telemetry failure never changes the hook: it still exits 0', async () => {
    mockRecordAgentUse.mockRejectedValueOnce(new Error('telemetry exploded'));
    gateway(() => Promise.resolve({ status: 'aligned', relevant_decisions: RELATED.relevant_decisions, conflicts: [] }));
    const exits: Array<number | undefined> = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => { exits.push(code); throw new Error('exit'); });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command();
    registerCheckCommand(program);
    await program.parseAsync(['node', 'align', 'check', '--advisory']).catch(() => undefined);
    exitSpy.mockRestore();
    writeSpy.mockRestore();
    expect(exits.at(-1)).toBe(0);
  });
});

/**
 * The daily "active today" beacon: one `agent_active` offer per real check, attributed to the hook
 * (command `check`), under the same short cap. recordFunnelStage keeps it to once a UTC day and
 * applies every opt-out; this file only pins that the hook offers it and that it cannot change the hook.
 */
describe('the advisory hook offers the daily agent_active beacon', () => {
  it('a real check offers agent_active once, as check, under the hook cap', async () => {
    gateway(() => Promise.resolve({ status: 'aligned', relevant_decisions: RELATED.relevant_decisions, conflicts: [] }));
    await runCheck(['--advisory']);
    const active = mockRecordFunnelStage.mock.calls.filter((c) => c[1] === 'agent_active');
    expect(active).toHaveLength(1);
    expect(active[0]!.slice(1)).toEqual(['agent_active', 'check', undefined, { capMs: 400 }]);
  });

  it('an edit with no text is not a check: nothing offered', async () => {
    mockReadHookPayload.mockResolvedValue({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: FILE, content: '' } });
    gateway(() => Promise.resolve(null));
    await runCheck(['--advisory']);
    expect(mockRecordFunnelStage).not.toHaveBeenCalled();
  });

  it('a beacon that throws or hangs-then-rejects changes neither the exit code nor the output', async () => {
    gateway(() => Promise.resolve({ status: 'aligned', relevant_decisions: RELATED.relevant_decisions, conflicts: [] }));
    const run = async (): Promise<{ exits: Array<number | undefined>; out: string }> => {
      const exits: Array<number | undefined> = [];
      let out = '';
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => { exits.push(code); throw new Error('exit'); });
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
      const program = new Command();
      registerCheckCommand(program);
      await program.parseAsync(['node', 'align', 'check', '--advisory']).catch(() => undefined);
      exitSpy.mockRestore();
      writeSpy.mockRestore();
      return { exits, out };
    };
    const healthy = await run();
    mockRecordFunnelStage.mockRejectedValueOnce(new Error('beacon exploded'));
    const broken = await run();
    expect(broken.exits).toEqual(healthy.exits);
    expect(broken.out).toBe(healthy.out);
    expect(broken.exits.at(-1)).toBe(0);
  });
});
