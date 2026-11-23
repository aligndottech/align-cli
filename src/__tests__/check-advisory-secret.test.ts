/**
 * The edit-time secret deny: a Write/Edit whose NEW text holds a known secret shape is refused on the first
 * attempt, in the agent hook's PRE branch, with no network, no model and no ratified rule. It also works in local
 * mode, which has no starter rules. The value is never echoed. Fixtures are built at runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import type * as SecretPrecheck from '../lib/secret-precheck.js';

const mockCheckAlignment = vi.fn();
const mockGetStarterRules = vi.fn();
let envMode: 'auth' | 'local-embedded' = 'auth';
let envName = 'prod';
let scanThrows = false;

vi.mock('../lib/setup-state.js', () => ({ isAlignSetUp: () => true }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: envMode })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => envName), resolveImportEnv: vi.fn(() => envName) }));
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
vi.mock('../lib/advisory-dedup.js', () => ({ dedupScope: (cwd: string) => cwd, recentlySurfaced: vi.fn(() => new Set<string>()), markSurfaced: vi.fn() }));
vi.mock('../lib/secret-precheck.js', async (orig) => {
  const real = await orig<typeof SecretPrecheck>();
  return { ...real, secretHitsInDiff: (d: string) => { if (scanThrows) throw new Error('boom'); return real.secretHitsInDiff(d); } };
});

const GH = `ghp_${'x'.repeat(36)}`;
const write = (content: string, event = 'PreToolUse') => ({ hook_event_name: event, tool_name: 'Write', tool_input: { file_path: 'deploy/.env', content } });
const edit = (new_string: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'deploy/.env', old_string: 'A=1', new_string } });

async function runCheck(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const program = new Command();
  registerCheckCommand(program);
  let stdout = '';
  let stderr = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => { throw new Error(`exit(${code})`); });
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((stdout += String(c)), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((stderr += String(c)), true));
  try { await program.parseAsync(['node', 'align', 'check', ...args]); } catch { /* process.exit throws */ } finally { exitSpy.mockRestore(); out.mockRestore(); err.mockRestore(); }
  return { stdout, stderr };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMode = 'auth'; envName = 'prod'; scanThrows = false;
  delete process.env.ALIGN_RULES_ACK;
  mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [], conflicts: [] });
});

describe('edit-time secret deny', () => {
  it('denies a Write whose content holds a GitHub token, naming kind and file, never the value, with no retrieval', async () => {
    mockReadHookPayload.mockResolvedValue(write(`A=1\nGITHUB_TOKEN=${GH}\n`));
    const { stdout } = await runCheck(['--advisory']);
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain('GitHub token');
    expect(stdout).toContain('deploy/.env');
    expect(stdout).not.toContain(GH);
    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(mockGetStarterRules).not.toHaveBeenCalled();
  });

  it('works in local mode, where there are no starter rules and no ratification', async () => {
    envMode = 'local-embedded'; envName = 'local';
    mockReadHookPayload.mockResolvedValue(edit(`T=${GH}`));
    const { stdout } = await runCheck(['--advisory']);
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).not.toContain(GH);
  });

  it('a harmless edit is not denied', async () => {
    mockReadHookPayload.mockResolvedValue(write('const x = 1;\n'));
    const { stdout } = await runCheck(['--advisory']);
    expect(stdout).not.toContain('deny');
  });

  it('a public SSH fingerprint is not denied', async () => {
    mockReadHookPayload.mockResolvedValue(write(`Signed with SHA256:${'nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8'}\n`));
    expect((await runCheck(['--advisory'])).stdout).not.toContain('deny');
  });

  it('the allow marker lets a deliberate fixture through', async () => {
    mockReadHookPayload.mockResolvedValue(write(`T=${GH} # align:allow-secret\n`));
    expect((await runCheck(['--advisory'])).stdout).not.toContain('deny');
  });

  it('an internal error in the scan fails open: the edit is not blocked', async () => {
    scanThrows = true;
    mockReadHookPayload.mockResolvedValue(write(`T=${GH}\n`));
    expect((await runCheck(['--advisory'])).stdout).not.toContain('deny');
  });

  it('never denies a PostToolUse (the edit already landed)', async () => {
    const git = await import('../lib/git.js');
    vi.mocked(git.getHeadDiff).mockResolvedValue(`diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+T=${GH}\n`);
    mockReadHookPayload.mockResolvedValue(write(`T=${GH}\n`, 'PostToolUse'));
    expect((await runCheck(['--advisory'])).stdout).not.toContain('deny');
  });

  it('ALIGN_RULES_ACK=1 is the break glass', async () => {
    process.env.ALIGN_RULES_ACK = '1';
    mockReadHookPayload.mockResolvedValue(write(`T=${GH}\n`));
    expect((await runCheck(['--advisory'])).stdout).not.toContain('deny');
  });

  it('renders in the host shape: Cursor and pi block their own way', async () => {
    mockReadHookPayload.mockResolvedValue(write(`T=${GH}\n`));
    expect((await runCheck(['--advisory', '--format', 'cursor'])).stdout).toContain('"permission":"deny"');
    expect((await runCheck(['--advisory', '--format', 'pi'])).stdout).toContain('"block":true');
  });
});
