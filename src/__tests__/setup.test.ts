import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ---- Hoisted mock state (must be hoisted so vi.mock factories can reference them) ----

const mockWhoami = vi.hoisted(() => vi.fn().mockResolvedValue({
  user: { email: 'test@test.com' },
  tenant: { name: 'Test Org', id: 'tid' },
}));
const mockIngestBatch = vi.hoisted(() => vi.fn().mockResolvedValue({ snapshots: [] }));
const mockListDecisionLinks = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockStartCliOAuth = vi.hoisted(() => vi.fn().mockResolvedValue({ authUrl: 'https://github.com/login/oauth/authorize?state=abc' }));
// mockStartCliOAuth accepts (key, port, nonce) - the mock ignores nonce but tests still pass

const mockMultiselect = vi.hoisted(() => vi.fn().mockResolvedValue(['git']));
const mockConfirm = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const mockSpinner = vi.hoisted(() => vi.fn(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
})));

const mockWaitForCallback = vi.hoisted(() => vi.fn().mockResolvedValue({
  data: { connector: 'github', credentials: { access_token: 'ghu_oauth_token' } },
  port: 7654,
}));

// ---- Mocks ----------------------------------------------------------------

vi.mock('../lib/cli-oauth.js', () => ({
  waitForCallback: mockWaitForCallback,
  CLI_CALLBACK_PORTS: [7654, 7655],
}));

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    whoami: mockWhoami,
    ingestBatch: mockIngestBatch,
    listDecisionLinks: mockListDecisionLinks,
    startCliOAuth: mockStartCliOAuth,
  })),
}));

const mockGetConnectorToken = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockSetConnectorToken = vi.hoisted(() => vi.fn());

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn().mockReturnValue({ gatewayUrl: 'http://localhost', authToken: 'tok' }),
    getDefaultEnv: vi.fn().mockReturnValue('prod'),
    setAuthToken: vi.fn(),
    setTenantId: vi.fn(),
    getConnectorToken: mockGetConnectorToken,
    setConnectorToken: mockSetConnectorToken,
    getConnectorCloudId: vi.fn().mockReturnValue(null),
    setConnectorCloudId: vi.fn(),
    getConnectorSiteBase: vi.fn().mockReturnValue(null),
    setConnectorSiteBase: vi.fn(),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn().mockReturnValue('http://app') }));

vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCommitHistory: vi.fn().mockResolvedValue([
    { sha: 'abc123', subject: 'feat: add thing', body: '', author: 'test', date: '2024-01-01' },
  ]),
  getRemoteUrl: vi.fn().mockResolvedValue(null),
  buildCommitUrl: vi.fn().mockReturnValue('git://commit/abc123'),
  formatCommitAsText: vi.fn().mockReturnValue('feat: add thing'),
}));

vi.mock('../lib/mcp-setup.js', () => ({
  detectEditors: vi.fn().mockReturnValue([]),
  writeMcpConfig: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
  spinner: mockSpinner,
  confirm: mockConfirm,
  multiselect: mockMultiselect,
  text: vi.fn().mockResolvedValue('test-value'),
  password: vi.fn().mockResolvedValue('test-token'),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../lib/fetchers/github.js', () => ({
  fetchGitHubItems: vi.fn().mockResolvedValue([
    { source_url: 'https://github.com/org/repo/pull/1', title: 'PR: add feature', raw_text: 'add feature', type: 'pull_request' },
  ]),
}));

vi.spyOn(console, 'log').mockImplementation(() => undefined);

// setTimeout is stubbed per-test to skip delays (e.g. 4-second deferred analysis wait)

// ---- Import under test after all mocks are hoisted -----------------------

import { registerSetupCommand } from '../commands/setup.js';

// ---- Helpers --------------------------------------------------------------

function makeProgram(): Command {
  const p = new Command();
  p.exitOverride(); // prevent process.exit in commander
  registerSetupCommand(p);
  return p;
}

// ---- Tests ----------------------------------------------------------------

describe('align setup', () => {
  beforeEach(() => {
    vi.stubGlobal('setTimeout', (fn: () => void) => { fn(); return 0; });
    vi.clearAllMocks();
    mockWhoami.mockResolvedValue({ user: { email: 'test@test.com' }, tenant: { name: 'Test Org' } });
    mockIngestBatch.mockResolvedValue({ snapshots: [{ id: 'snap1', analysis: { relatedDecisions: [] } }] });
    mockListDecisionLinks.mockResolvedValue([]);
    mockMultiselect.mockResolvedValue(['git']);
    mockConfirm.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('registers the setup command without throwing', () => {
    expect(() => {
      const p = new Command();
      registerSetupCommand(p);
    }).not.toThrow();
  });

  it('calls whoami to verify authentication on the happy path', async () => {
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(mockWhoami).toHaveBeenCalled();
  });

  it('exits with a warning when whoami fails (unauthenticated)', async () => {
    mockWhoami.mockRejectedValueOnce(new Error('401'));
    const { log } = await import('@clack/prompts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(
      makeProgram().parseAsync(['node', 'align', 'setup', '--approve']),
    ).rejects.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('align login'));
    exitSpy.mockRestore();
  });

  it('calls multiselect to collect source selection', async () => {
    const { multiselect } = await import('@clack/prompts');
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('source') }),
    );
  });

  it('runs ingestBatch when git is selected', async () => {
    mockMultiselect.mockResolvedValueOnce(['git']);
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(mockIngestBatch).toHaveBeenCalled();
  });

  it('snapshots pre-import link count before importing', async () => {
    mockListDecisionLinks
      .mockResolvedValueOnce([{ id: 'existing' }]) // pre-import baseline
      .mockResolvedValueOnce([{ id: 'existing' }, { id: 'new' }]); // post-import
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    // listDecisionLinks should be called at least twice: once before imports, once after
    expect(mockListDecisionLinks.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('calls detectEditors after imports to offer MCP setup', async () => {
    const { detectEditors } = await import('../lib/mcp-setup.js');
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(detectEditors).toHaveBeenCalled();
  });

  it('writes MCP config when an editor is detected and user confirms', async () => {
    const { detectEditors, writeMcpConfig } = await import('../lib/mcp-setup.js');
    (detectEditors as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { name: 'Claude Desktop', configPath: '/tmp/test.json', configKey: 'mcpServers' },
    ]);
    mockConfirm.mockResolvedValueOnce(true);
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(writeMcpConfig).toHaveBeenCalled();
  });

  it('skips import and warns when no items are returned from a source', async () => {
    const { log } = await import('@clack/prompts');
    const { getCommitHistory } = await import('../lib/git.js');
    (getCommitHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    mockMultiselect.mockResolvedValueOnce(['git']);
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No items found'));
  });

  it('continues setup when a source fetch throws', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    (getCommitHistory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no git'));
    mockMultiselect.mockResolvedValueOnce(['git']);
    // Should not throw - wizard continues to outro
    await expect(
      makeProgram().parseAsync(['node', 'align', 'setup', '--approve']),
    ).resolves.not.toThrow();
  });

  describe('OAuth browser flow for connectors', () => {
    it('uses waitForCallback for GitHub instead of prompting for a token', async () => {
      mockMultiselect.mockResolvedValueOnce(['github']);
      mockWaitForCallback.mockResolvedValueOnce({
        data: { connector: 'github', credentials: { access_token: 'ghu_oauth_token' } },
        port: 7654,
      });
      const { password } = await import('@clack/prompts');
      await makeProgram().parseAsync(['node', 'align', 'setup']);
      expect(mockWaitForCallback).toHaveBeenCalled();
      expect(password).not.toHaveBeenCalled();
    });

    it('passes OAuth access_token to the GitHub fetcher', async () => {
      mockMultiselect.mockResolvedValueOnce(['github']);
      mockWaitForCallback.mockResolvedValueOnce({
        data: { connector: 'github', credentials: { access_token: 'ghu_from_oauth' } },
        port: 7654,
      });
      const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
      await makeProgram().parseAsync(['node', 'align', 'setup']);
      expect(fetchGitHubItems).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghu_from_oauth' }));
    });

    it('caches the OAuth token and skips browser flow on repeat run', async () => {
      mockMultiselect.mockResolvedValue(['github']);
      mockGetConnectorToken.mockReturnValueOnce('ghu_cached_token');
      await makeProgram().parseAsync(['node', 'align', 'setup']);
      expect(mockWaitForCallback).not.toHaveBeenCalled();
      const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
      expect(fetchGitHubItems).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghu_cached_token' }));
    });

    it('saves the OAuth token to config after successful OAuth', async () => {
      mockMultiselect.mockResolvedValueOnce(['github']);
      mockWaitForCallback.mockResolvedValueOnce({
        data: { connector: 'github', credentials: { access_token: 'ghu_new_token' } },
        port: 7654,
      });
      await makeProgram().parseAsync(['node', 'align', 'setup']);
      expect(mockSetConnectorToken).toHaveBeenCalledWith('prod', 'github', 'ghu_new_token');
    });
  });

  it('calls cancel and exits when source selection is cancelled', async () => {
    const { multiselect, isCancel, cancel } = await import('@clack/prompts');
    (isCancel as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    (multiselect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Symbol('cancel'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(
      makeProgram().parseAsync(['node', 'align', 'setup', '--approve']),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
