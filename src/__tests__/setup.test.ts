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

const mockExeca = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: '/usr/local/bin/align' }));

// ---- Mocks ----------------------------------------------------------------

vi.mock('execa', () => ({ execa: mockExeca }));

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

// Mock all fetchers so setup tests don't make real network calls
// Mock fetchers that have no more-specific mock below to prevent real network calls in tests
vi.mock('../lib/fetchers/jira.js', () => ({ fetchJiraItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/fetchers/confluence.js', () => ({ fetchConfluenceItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/fetchers/slack.js', () => ({ fetchSlackItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/fetchers/teams.js', () => ({ fetchTeamsItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/fetchers/zoom.js', () => ({ fetchZoomItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/fetchers/gitlab.js', () => ({ fetchGitLabItems: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/fetchers/notion.js', () => ({ fetchNotionItems: vi.fn().mockResolvedValue([]) }));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), success: vi.fn() },
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

vi.mock('../lib/fetchers/linear.js', () => ({
  fetchLinearItems: vi.fn().mockResolvedValue([
    { source_url: 'https://linear.app/team/issue/ISS-1', title: 'Issue: fix bug', raw_text: 'fix bug', type: 'issue' },
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
    mockMultiselect.mockResolvedValue([]);
    mockConfirm.mockResolvedValue(false);
    mockExeca.mockResolvedValue({ stdout: '/usr/local/bin/align' });
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

  it('shows the connector multiselect with a "connect more sources" message', async () => {
    const { multiselect } = await import('@clack/prompts');
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Connect more sources') }),
    );
  });

  it('auto-imports git commits without showing git in the connector multiselect', async () => {
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(mockIngestBatch).toHaveBeenCalled();
    // git should not appear as an option in the connector multiselect
    const { multiselect } = await import('@clack/prompts');
    const connectorCall = (multiselect as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0]?.message?.includes('Connect more sources'),
    );
    const options = connectorCall?.[0]?.options ?? [];
    expect(options.every((o: { value: string }) => o.value !== 'git')).toBe(true);
  });

  it('detects editors and writes MCP config before import', async () => {
    const { detectEditors, writeMcpConfig } = await import('../lib/mcp-setup.js');
    (detectEditors as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { name: 'Claude Code', configPath: '/tmp/.claude.json', configKey: 'mcpServers' },
    ]);
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(writeMcpConfig).toHaveBeenCalled();
  });

  it('git import skips silently when no commits found', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    (getCommitHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(mockIngestBatch).not.toHaveBeenCalled();
  });

  it('continues setup when git fetch throws', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    (getCommitHistory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no git'));
    await expect(
      makeProgram().parseAsync(['node', 'align', 'setup', '--approve']),
    ).resolves.not.toThrow();
  });

  it('completes setup without calling startCliOAuth when no connectors are selected', async () => {
    mockMultiselect.mockResolvedValue([]);
    await expect(
      makeProgram().parseAsync(['node', 'align', 'setup', '--approve']),
    ).resolves.not.toThrow();
    expect(mockStartCliOAuth).not.toHaveBeenCalled();
  });

  it('shows pricing link in outro regardless of import count', async () => {
    mockMultiselect.mockResolvedValue([]);
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    const { outro } = await import('@clack/prompts');
    expect((outro as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('app.align.tech/pricing');
  });

  describe('PATH check', () => {
    it('warns with install command when align is not on PATH', async () => {
      mockExeca.mockRejectedValueOnce(new Error('not found'));
      const { log } = await import('@clack/prompts');
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('npm install -g @aligndottech/cli'));
    });

    it('does not warn about PATH when align is found', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '/usr/local/bin/align' });
      const { log } = await import('@clack/prompts');
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls as string[][];
      expect(warnCalls.every(c => !String(c[0]).includes('npm install -g'))).toBe(true);
    });
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
      expect(mockSetConnectorToken).toHaveBeenCalledWith('prod', 'github-personal', 'ghu_new_token');
    });
  });

  describe('token-paste connectors auto-open browser', () => {
    it('opens the Linear token URL in the browser before prompting for the token', async () => {
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['linear']);
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(open).toHaveBeenCalledWith('https://linear.app/settings/api');
    });

    it('opens the Notion integrations URL in the browser before prompting for the token', async () => {
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['notion']);
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(open).toHaveBeenCalledWith('https://www.notion.so/my-integrations');
    });

    it('opens gitlab.com token URL when no custom domain entered', async () => {
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['gitlab']);
      // text() for domain field returns empty string, password() for the token
      const { text } = await import('@clack/prompts');
      (text as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining('gitlab.com/-/user_settings/personal_access_tokens'),
      );
    });

    it('opens self-managed GitLab token URL when custom domain is entered', async () => {
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['gitlab']);
      const { text } = await import('@clack/prompts');
      (text as ReturnType<typeof vi.fn>).mockResolvedValueOnce('gitlab.mycompany.com');
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(open).toHaveBeenCalledWith(
        'https://gitlab.mycompany.com/-/user_settings/personal_access_tokens',
      );
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
