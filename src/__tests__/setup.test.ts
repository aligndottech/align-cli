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
// Intent prompt: default to 'cloud' in tests so the existing cloud-flow tests
// (which call `align setup` without --approve) keep exercising the cloud path.
// Solo now means personal cloud tenant; local is the opt-in --local escape hatch.
const mockSelect = vi.hoisted(() => vi.fn().mockResolvedValue('cloud'));
const mockInitLocalMode = vi.hoisted(() => vi.fn().mockResolvedValue({ dbPath: '/tmp/local.db' }));
const mockConfirm = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const spinnerInstances = vi.hoisted(() => [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; succeed: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> }>);
const mockSpinner = vi.hoisted(() => vi.fn(() => {
  const inst = { start: vi.fn(), stop: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
  spinnerInstances.push(inst);
  return inst;
}));

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

vi.mock('../lib/local-mode.js', () => ({
  initLocalMode: mockInitLocalMode,
}));

const mockLoginInteractive = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/login-flow.js', () => ({
  loginInteractive: mockLoginInteractive,
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
  select: mockSelect,
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

  it('exits with a warning when whoami fails under --approve (scripted, no inline login)', async () => {
    mockWhoami.mockRejectedValueOnce(new Error('401'));
    const { log } = await import('@clack/prompts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(
      makeProgram().parseAsync(['node', 'align', 'setup', '--approve']),
    ).rejects.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('align login'));
    expect(mockLoginInteractive).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('logs in inline (interactive) when unauthenticated, then continues setup', async () => {
    // First auth check fails; user confirms "Log in now?"; inline login succeeds;
    // second whoami (after re-creating the client) succeeds and setup proceeds.
    mockWhoami.mockRejectedValueOnce(new Error('401'));
    mockConfirm.mockResolvedValueOnce(true);
    mockLoginInteractive.mockResolvedValueOnce(true);
    await makeProgram().parseAsync(['node', 'align', 'setup']);
    expect(mockLoginInteractive).toHaveBeenCalled();
    // Proceeded past auth into the cloud flow (git import ran)
    expect(mockIngestBatch).toHaveBeenCalled();
    expect(mockInitLocalMode).not.toHaveBeenCalled();
  });

  it('falls back to local mode when interactive login is declined', async () => {
    mockWhoami.mockRejectedValueOnce(new Error('401'));
    mockConfirm.mockResolvedValueOnce(false); // decline "Log in now?"
    mockConfirm.mockResolvedValueOnce(true);   // accept "Set up local instead?"
    await makeProgram().parseAsync(['node', 'align', 'setup']);
    expect(mockLoginInteractive).not.toHaveBeenCalled();
    expect(mockInitLocalMode).toHaveBeenCalled();
  });

  it('shows the connector multiselect with a "connect more sources" message', async () => {
    const { multiselect } = await import('@clack/prompts');
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Connect more sources') }),
    );
  });

  it('orders connectors personal-frictionless first, then site-scoped, then workspace-admin', async () => {
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    const connectorCall = mockMultiselect.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes('Connect more sources'),
    );
    expect(connectorCall).toBeDefined();
    const ids = connectorCall![0].options.map((o: { value: string }) => o.value);
    // personal-frictionless connectors precede site-scoped Atlassian, which precede workspace-admin
    const lastPersonal = Math.max(ids.indexOf('github'), ids.indexOf('gitlab'), ids.indexOf('linear'), ids.indexOf('notion'), ids.indexOf('zoom'));
    const firstSite = Math.min(ids.indexOf('jira'), ids.indexOf('confluence'));
    const firstWorkspace = Math.min(ids.indexOf('slack'), ids.indexOf('teams'));
    expect(lastPersonal).toBeLessThan(firstSite);
    expect(firstSite).toBeLessThan(firstWorkspace);
  });

  it('labels Slack and Teams as needing workspace/org admin', async () => {
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    const connectorCall = mockMultiselect.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes('Connect more sources'),
    );
    const byId = (id: string) => connectorCall![0].options.find((o: { value: string }) => o.value === id);
    expect(byId('slack').hint).toMatch(/workspace|admin/i);
    expect(byId('teams').hint).toMatch(/workspace|admin/i);
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

  it('stops the git spinner before batch import begins (no overlapping spinners)', async () => {
    spinnerInstances.length = 0;
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);

    // The git phase uses a clack spinner; runPersonalImport uses its own ora spinner.
    // Find the git-phase spinner by its start/stop message.
    const gitSpinner = spinnerInstances.find(s =>
      s.start.mock.calls.some((c: unknown[]) => /git/i.test(String(c[0]))) ||
      s.stop.mock.calls.some((c: unknown[]) => /git/i.test(String(c[0]))),
    );
    expect(gitSpinner).toBeDefined();
    expect(gitSpinner!.stop).toHaveBeenCalled();
    expect(mockIngestBatch).toHaveBeenCalled();

    // The git spinner must stop BEFORE batch import (ingestBatch) runs - otherwise
    // runPersonalImport's ora spinner overlaps it and the terminal line flickers.
    const spinnerStopOrder = gitSpinner!.stop.mock.invocationCallOrder[0];
    const firstIngestOrder = mockIngestBatch.mock.invocationCallOrder[0];
    expect(spinnerStopOrder).toBeLessThan(firstIngestOrder);
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

  describe('cloud (default) / local (--local) mode', () => {
    it('--local sets up local mode without cloud auth, and imports git', async () => {
      await makeProgram().parseAsync(['node', 'align', 'setup', '--local']);
      expect(mockInitLocalMode).toHaveBeenCalled();
      // Local escape hatch never calls whoami (no cloud login required) and never OAuths
      expect(mockWhoami).not.toHaveBeenCalled();
      expect(mockWaitForCallback).not.toHaveBeenCalled();
      // Git history still imported (into the local graph)
      expect(mockIngestBatch).toHaveBeenCalled();
    });

    it('--local offers read-only token-paste connectors and imports a selected one into the local graph (ALI-103)', async () => {
      mockMultiselect.mockResolvedValueOnce(['linear']); // local connector step
      const { password } = await import('@clack/prompts');
      const { fetchLinearItems } = await import('../lib/fetchers/linear.js');
      mockIngestBatch.mockClear();
      await makeProgram().parseAsync(['node', 'align', 'setup', '--local']);
      // pasted a token (no OAuth) and fetched + imported into the local graph
      expect(password).toHaveBeenCalled();
      expect(fetchLinearItems).toHaveBeenCalled();
      expect(mockIngestBatch).toHaveBeenCalled();
      expect(mockWaitForCallback).not.toHaveBeenCalled();
      expect(mockWhoami).not.toHaveBeenCalled();
    });

    it('--local does NOT offer Teams or Zoom (no personal token)', async () => {
      await makeProgram().parseAsync(['node', 'align', 'setup', '--local']);
      const connectorCall = mockMultiselect.mock.calls.find(
        (c: any[]) => c[0]?.message?.toLowerCase().includes('read-only token'),
      );
      expect(connectorCall).toBeDefined();
      const values = (connectorCall![0].options as Array<{ value: string }>).map((o) => o.value);
      expect(values).not.toContain('teams');
      expect(values).not.toContain('zoom');
      expect(values).toEqual(expect.arrayContaining(['github', 'jira', 'linear', 'gitlab', 'notion']));
    });

    it('defaults the interactive intent prompt to the cloud personal path (not local)', async () => {
      // mockSelect default is 'cloud'
      await makeProgram().parseAsync(['node', 'align', 'setup']);
      expect(mockWhoami).toHaveBeenCalled();
      expect(mockInitLocalMode).not.toHaveBeenCalled();
    });

    it('routes to local mode when the user selects "local" in the intent prompt', async () => {
      mockSelect.mockResolvedValueOnce('local');
      await makeProgram().parseAsync(['node', 'align', 'setup']);
      expect(mockInitLocalMode).toHaveBeenCalled();
      expect(mockWhoami).not.toHaveBeenCalled();
    });

    it('--approve runs the cloud path non-interactively (no prompt, no local mode, auth checked)', async () => {
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(mockInitLocalMode).not.toHaveBeenCalled();
      expect(mockWhoami).toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
    });
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

  it('cloud outro mentions upgrading to a team and notes connectors re-auth after joining', async () => {
    mockMultiselect.mockResolvedValue([]);
    await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
    const { outro } = await import('@clack/prompts');
    const text = (outro as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Upgrade path is the web join flow; decisions carry over, connectors do not.
    expect(text).toMatch(/team/i);
    expect(text).toMatch(/reconnect|re-?auth|connect.*again/i);
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

    it('enables both Jira and Confluence from a single Atlassian consent (sibling payload)', async () => {
      mockMultiselect.mockResolvedValueOnce(['jira', 'confluence']);
      mockWaitForCallback.mockResolvedValueOnce({
        data: {
          // Read-only personal tier: the gateway resolves the jira-personal alias
          // and returns the confluence-personal sibling from the single consent.
          connector: 'jira-personal',
          credentials: { access_token: 'atl_token', site_id: 'cloud-1', base: 'https://x.atlassian.net' },
          siblingConnector: 'confluence-personal',
          siblingCredentials: { access_token: 'atl_token', site_id: 'cloud-1', base: 'https://x.atlassian.net' },
        },
        port: 7654,
      });
      // Once the sibling token is persisted, confluence's own iteration finds it cached
      mockGetConnectorToken.mockImplementation((_env: string, key: string) =>
        key === 'confluence-personal' ? 'atl_token' : null,
      );
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(mockSetConnectorToken).toHaveBeenCalledWith('prod', 'jira-personal', 'atl_token');
      expect(mockSetConnectorToken).toHaveBeenCalledWith('prod', 'confluence-personal', 'atl_token');
      // Only ONE browser OAuth flow despite two Atlassian connectors selected
      expect(mockWaitForCallback).toHaveBeenCalledTimes(1);
    });

    it('still reuses the Atlassian sibling under --reset (one consent, no second sign-in)', async () => {
      // --reset must ignore STALE prior-run tokens but NOT force a second
      // Atlassian sign-in for a sibling connected moments ago this run (ALI-106).
      mockMultiselect.mockResolvedValueOnce(['jira', 'confluence']);
      mockWaitForCallback.mockResolvedValueOnce({
        data: {
          connector: 'jira-personal',
          credentials: { access_token: 'atl_token', site_id: 'cloud-1', base: 'https://x.atlassian.net' },
          siblingConnector: 'confluence-personal',
          siblingCredentials: { access_token: 'atl_token', site_id: 'cloud-1', base: 'https://x.atlassian.net' },
        },
        port: 7654,
      });
      mockGetConnectorToken.mockImplementation((_env: string, key: string) =>
        key === 'confluence-personal' ? 'atl_token' : null,
      );
      await makeProgram().parseAsync(['node', 'align', 'setup', '--reset', '--approve']);
      expect(mockWaitForCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('connector import ordering', () => {
    it('collects all OAuth consents before fetching any connector data (consents back-to-back)', async () => {
      mockMultiselect.mockResolvedValueOnce(['github', 'slack']);
      mockWaitForCallback.mockResolvedValue({ data: { connector: 'x', credentials: { access_token: 'tok' } }, port: 7654 });
      const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
      const { fetchSlackItems } = await import('../lib/fetchers/slack.js');
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(mockWaitForCallback).toHaveBeenCalledTimes(2);
      const lastConsent = Math.max(...mockWaitForCallback.mock.invocationCallOrder);
      const fetchOrders = [
        ...(fetchGitHubItems as ReturnType<typeof vi.fn>).mock.invocationCallOrder,
        ...(fetchSlackItems as ReturnType<typeof vi.fn>).mock.invocationCallOrder,
      ];
      expect(fetchOrders.length).toBeGreaterThan(0);
      // Every consent finishes before any data fetch starts
      expect(lastConsent).toBeLessThan(Math.min(...fetchOrders));
    });

    it('fetches selected connectors concurrently, not one after another', async () => {
      mockMultiselect.mockResolvedValueOnce(['github', 'slack']);
      mockWaitForCallback.mockResolvedValue({ data: { connector: 'x', credentials: { access_token: 'tok' } }, port: 7654 });

      const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
      const { fetchSlackItems } = await import('../lib/fetchers/slack.js');
      const order: string[] = [];
      // GitHub fetch is slow; if fetches run concurrently, Slack starts before
      // GitHub finishes. If they run sequentially, Slack only starts after
      // GitHub has fully resolved.
      (fetchGitHubItems as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('gh-start');
        await new Promise((r) => setTimeout(r, 15));
        order.push('gh-end');
        return [];
      });
      (fetchSlackItems as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('slack-start');
        return [];
      });

      try {
        await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
        expect(order).toContain('slack-start');
        expect(order).toContain('gh-end');
        expect(order.indexOf('slack-start')).toBeLessThan(order.indexOf('gh-end'));
      } finally {
        (fetchGitHubItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        (fetchSlackItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      }
    });

    it('imports all connected sources via the parallel import path (ALI-108)', async () => {
      mockMultiselect.mockResolvedValueOnce(['github', 'linear']);
      mockWaitForCallback.mockResolvedValue({ data: { connector: 'x', credentials: { access_token: 'tok' } }, port: 7654 });
      // Set fetcher returns explicitly - other tests mutate these module mocks.
      const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
      const { fetchLinearItems } = await import('../lib/fetchers/linear.js');
      (fetchGitHubItems as ReturnType<typeof vi.fn>).mockResolvedValue([
        { source_url: 'https://github.com/org/repo/pull/1', title: 'PR', raw_text: 'x', type: 'pull_request' },
      ]);
      (fetchLinearItems as ReturnType<typeof vi.fn>).mockResolvedValue([
        { source_url: 'https://linear.app/team/issue/ISS-1', title: 'Issue', raw_text: 'x', type: 'issue' },
      ]);
      const { log } = await import('@clack/prompts');
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      // The parallel import phase announces itself...
      expect((log.step as ReturnType<typeof vi.fn>).mock.calls.some((c) => /parallel/i.test(String(c[0])))).toBe(true);
      // ...and every connected source is ingested (github + linear items both sent).
      const ingestedUrls = mockIngestBatch.mock.calls.flatMap(
        (c) => (c[0] as Array<{ source_url: string }>).map((i) => i.source_url),
      );
      expect(ingestedUrls.some((u) => u.includes('github'))).toBe(true);
      expect(ingestedUrls.some((u) => u.includes('linear'))).toBe(true);
    });
  });

  describe('token-paste connectors auto-open browser', () => {
    it('uses browser OAuth for Linear (read-only), not an API-key paste', async () => {
      // Linear moved from API-key paste to oauthKey:'linear-personal' (ALI-101): it should
      // start the CLI OAuth flow, not open the settings/API token page.
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['linear']);
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      // OAuth path runs the browser callback flow; paste path would instead open
      // the settings/API token page.
      expect(mockWaitForCallback).toHaveBeenCalled();
      expect(open).not.toHaveBeenCalledWith('https://linear.app/settings/api');
    });

    it('uses browser OAuth for Notion (read-only), not an integration-secret paste', async () => {
      // Notion moved from internal-integration-secret paste to
      // oauthKey:'notion-personal' (ALI-104): cloud setup should start the CLI
      // OAuth flow, not open the my-integrations page.
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['notion']);
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(mockWaitForCallback).toHaveBeenCalled();
      expect(open).not.toHaveBeenCalledWith('https://www.notion.so/my-integrations');
    });

    it('uses browser OAuth for gitlab.com (blank domain), not a PAT paste', async () => {
      // gitlab.com (blank domain) → host-gated OAuth (ALI-102), not the token page.
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['gitlab']);
      const { text } = await import('@clack/prompts');
      (text as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined); // blank submit returns undefined
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      expect(mockWaitForCallback).toHaveBeenCalled();
      expect(open).not.toHaveBeenCalledWith(
        expect.stringContaining('/-/user_settings/personal_access_tokens'),
      );
    });

    it('falls back to a PAT paste for a self-managed GitLab host', async () => {
      const open = (await import('open')).default;
      mockMultiselect.mockResolvedValueOnce(['gitlab']);
      const { text } = await import('@clack/prompts');
      (text as ReturnType<typeof vi.fn>).mockResolvedValueOnce('gitlab.mycompany.com');
      await makeProgram().parseAsync(['node', 'align', 'setup', '--approve']);
      // self-managed → token page on that host, no OAuth callback
      expect(open).toHaveBeenCalledWith(
        'https://gitlab.mycompany.com/-/user_settings/personal_access_tokens',
      );
      expect(mockWaitForCallback).not.toHaveBeenCalled();
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
