/**
 * The advisory hook denies a FIRST attempt when a RATIFIED deterministic rule is
 * broken, with no model call and no retry needed.
 *
 * Pairs: ratified -> deny citing the rule / not ratified -> context only. Fetching the rules
 * fails -> the edit proceeds (fail-open, said out loud on stderr). The rules are fetched only
 * when the text actually matches, so an ordinary edit pays no extra request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();
const mockGetStarterRules = vi.fn();

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
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));
const mockReadHookPayload = vi.fn(() => Promise.resolve<unknown>(null));
vi.mock('../lib/hook-payload.js', () => ({ readHookPayload: () => mockReadHookPayload() }));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment, getStarterRules: mockGetStarterRules })),
}));
vi.mock('../lib/advisory-dedup.js', () => ({
  recentlySurfaced: vi.fn(() => new Set<string>()),
  markSurfaced: vi.fn(),
}));

const payload = (text: string, event = 'PreToolUse') => ({
  hook_event_name: event,
  tool_name: 'Write',
  tool_input: { file_path: 'fixtures/ticket.json', content: text },
});
const RULES = (status: 'accepted' | 'offered') => ({
  templates: [{
    id: 'customer-data-in-tickets', version: 1, status, decisionId: 'd-9', matchers: ['deterministic', 'semantic'],
    statement: 'Customer names, email addresses and account data do not go into tickets.', rationale: 'r',
  }],
});

async function runCheck(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const program = new Command();
  registerCheckCommand(program);
  let stdout = '';
  let stderr = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`exit(${code})`);
  });
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((stdout += String(c)), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((stderr += String(c)), true));
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    out.mockRestore();
    err.mockRestore();
  }
  return { stdout, stderr };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [], conflicts: [] });
});

describe('inline deterministic deny', () => {
  it('denies the FIRST edit that adds an email when the customer-data rule is ratified, citing the rule', async () => {
    mockReadHookPayload.mockResolvedValue(payload('{"reporter":"jane.doe@acmecorp.io"}'));
    mockGetStarterRules.mockResolvedValue(RULES('accepted'));

    const { stdout } = await runCheck(['--advisory']);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain('Customer names, email addresses');
    expect(stdout).toContain('an email address');
    expect(stdout).not.toContain('jane.doe@acmecorp.io'); // the value is never echoed back
    expect(mockCheckAlignment).not.toHaveBeenCalled(); // no retrieval, no model: inline
  });

  it('does NOT deny when the rule is offered but not ratified', async () => {
    mockReadHookPayload.mockResolvedValue(payload('{"reporter":"jane.doe@acmecorp.io"}'));
    mockGetStarterRules.mockResolvedValue(RULES('offered'));

    const { stdout } = await runCheck(['--advisory']);

    expect(stdout).not.toContain('deny');
  });

  it('proceeds, and says why on stderr, when the ratified rules cannot be read', async () => {
    mockReadHookPayload.mockResolvedValue(payload('{"reporter":"jane.doe@acmecorp.io"}'));
    mockGetStarterRules.mockRejectedValue(new Error('Cannot reach gateway'));

    const { stdout, stderr } = await runCheck(['--advisory']);

    expect(stdout).not.toContain('deny');
    expect(stderr).toContain('could not read');
  });

  it('an edit with nothing to match fetches no rules at all', async () => {
    mockReadHookPayload.mockResolvedValue(payload('const x = 1;'));

    await runCheck(['--advisory']);

    expect(mockGetStarterRules).not.toHaveBeenCalled();
  });

  it('never denies a PostToolUse (the edit already landed)', async () => {
    mockReadHookPayload.mockResolvedValue(payload('{"reporter":"jane.doe@acmecorp.io"}', 'PostToolUse'));
    mockGetStarterRules.mockResolvedValue(RULES('accepted'));

    const { stdout } = await runCheck(['--advisory']);

    expect(stdout).not.toContain('deny');
  });

  it('renders the deny in the host shape: Cursor and pi block their own way', async () => {
    mockReadHookPayload.mockResolvedValue(payload('{"reporter":"jane.doe@acmecorp.io"}'));
    mockGetStarterRules.mockResolvedValue(RULES('accepted'));

    expect((await runCheck(['--advisory', '--format', 'cursor'])).stdout).toContain('"permission":"deny"');
    expect((await runCheck(['--advisory', '--format', 'pi'])).stdout).toContain('"block":true');
  });

  it('ALIGN_RULES_ACK=1 is the break glass: a confirmed edit goes through', async () => {
    mockReadHookPayload.mockResolvedValue(payload('{"reporter":"jane.doe@acmecorp.io"}'));
    mockGetStarterRules.mockResolvedValue(RULES('accepted'));
    vi.stubEnv('ALIGN_RULES_ACK', '1');
    try {
      const { stdout } = await runCheck(['--advisory']);
      expect(stdout).not.toContain('deny');
      expect(mockGetStarterRules).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
