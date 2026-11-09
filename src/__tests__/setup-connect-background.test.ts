/**
 * Setup no longer waits on connector reads. The consent questions (token, scope) are still asked,
 * the token and scope are saved, and one background child reads every such source, so the agent
 * opens at once. GitHub and GitLab stay in the foreground: their scope comes from the folder's remote
 * and is not saved, and the child runs from the home directory, so it would read less.
 *
 * Test List:
 * - Background Jira: nothing fetched inline, token saved, one child started with ['jira'], result deferred.
 * - Two background sources start one child with both.
 * - GitHub is still read in the foreground with background on.
 * - The child cannot start: the sources are read in the foreground after one line saying so.
 * - Without background (`align connect`) nothing changes: Jira is fetched inline, no child.
 * - The child starts now (delay 0) as the launcher, never as an agent.
 */
import { vendorFetch } from './helpers/vendor-fetch.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ScopeConnect from '../lib/scope-connect.js';

const mockMultiselect = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockPassword = vi.hoisted(() => vi.fn().mockResolvedValue('pasted-token'));
const mockConfirm = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: mockConfirm,
  multiselect: mockMultiselect,
  password: mockPassword,
  text: vi.fn().mockResolvedValue(''),
  isCancel: () => false,
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), step: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

const mockFetchGitHub = vi.hoisted(() => vi.fn().mockResolvedValue({
  items: [{ source_url: 'https://github.com/o/r/pull/1', title: 'PR: a', raw_text: 'a', type: 'pull_request' }],
  report: { scanned: 1, skips: [] },
}));
const mockResolveRepo = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/fetchers/github.js', () => ({
  fetchGitHubItems: mockFetchGitHub,
  resolveGitHubRepoScope: mockResolveRepo,
}));
const mockFetchJira = vi.hoisted(() => vi.fn().mockResolvedValue({ items: [], report: { scanned: 0, skips: [] } }));
const mockFetchLinear = vi.hoisted(() => vi.fn().mockResolvedValue({ items: [], report: { scanned: 0, skips: [] } }));
vi.mock('../lib/fetchers/jira.js', () => ({ fetchJiraItems: mockFetchJira }));
vi.mock('../lib/fetchers/linear.js', () => ({ fetchLinearItems: mockFetchLinear }));
for (const m of ['confluence', 'slack', 'teams', 'zoom', 'gitlab', 'notion', 'docs', 'git']) {
  vi.doMock(`../lib/fetchers/${m}.js`, () => ({}));
}

const mockRunPersonalImport = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: mockRunPersonalImport, runWithConcurrency: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ ingestBatch: vi.fn() })) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'http://app') }));
const mockResolveImportEnv = vi.hoisted(() => vi.fn(() => 'local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local'), resolveImportEnv: mockResolveImportEnv }));
vi.mock('../lib/local-mode.js', () => ({ initLocalMode: vi.fn().mockResolvedValue({ dbPath: '/tmp/local.db' }) }));
// The CLI-token shortcut (`gh auth token`) and the browser opener are outside this suite.
vi.mock('../lib/setup-ux.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  detectVerifiedCliToken: vi.fn().mockResolvedValue(null),
  clearScreenForPicker: vi.fn(),
}));
vi.mock('../lib/open-url.js', () => ({ tryOpenUrl: vi.fn().mockResolvedValue(true) }));
vi.mock('execa', () => ({ execa: vi.fn().mockResolvedValue({ stdout: '' }) }));

// L5: a successful foreground connect clears needs_reauth (the helper is tested on its own).
const mockAfterConnected = vi.hoisted(() => vi.fn());
vi.mock('../lib/sync/after-connect.js', () => ({ afterSourceConnected: mockAfterConnected }));

const mockGetConnectorFields = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockSaveConnectorFields = vi.hoisted(() => vi.fn());
const mockSetConnectorScope = vi.hoisted(() => vi.fn());
const mockGetScope = vi.hoisted(() => vi.fn((_e: string, _s: string): unknown => null));
const mockMarkDisclosed = vi.hoisted(() => vi.fn());
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://localhost', authToken: null, tenantId: null, mode: 'local-embedded', localDbPath: '/tmp/local.db' })),
    getDefaultEnv: vi.fn(() => 'prod'),
    getConnectorFields: mockGetConnectorFields,
    saveConnectorFields: mockSaveConnectorFields,
    forgetConnector: vi.fn(),
    getConnectorScope: mockGetScope, setConnectorScope: mockSetConnectorScope, clearConnectorScope: vi.fn(),
    isTeamScopeDisclosed: vi.fn(() => false), markTeamScopeDisclosed: mockMarkDisclosed, clearTeamScopeDisclosed: vi.fn(),
    getConnectorToken: vi.fn(() => null),
    getConnectorCloudId: vi.fn(() => null),
    getConnectorSiteBase: vi.fn(() => null),
  })),
}));

const stdout: string[] = [];
const stderr: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });


// Counted, not replaced. fetchUnderScope asks the scope step again; setup calls it from outside the module, so the count is real.
const decideSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/scope-connect.js', async (orig) => {
  const real = await orig<typeof ScopeConnect>();
  return { ...real, fetchUnderScope: (...a: Parameters<typeof real.fetchUnderScope>) => { decideSpy.calls++; return real.fetchUnderScope(...a); } };
});
const mockProve = vi.hoisted(() => vi.fn(async () => 'ok' as 'ok' | 'refused' | 'unknown'));
vi.mock('../lib/scope-choices.js', async (orig) => ({ ...(await orig<object>()), proveToken: mockProve }));
const { connectLocalSources } = await import('../commands/setup.js');
const { createConfigStore } = await import('../lib/config.js');
const p = await import('@clack/prompts');

const JIRA = { email: 'e@x.dev', domain: 'x.atlassian.net', token: 'jira-tok' };

async function connect(over: Record<string, unknown>) {
  const config = createConfigStore();
  const capture = { add: vi.fn(() => ({})), render: vi.fn() };
  return connectLocalSources({
    interactive: false, approve: true, config, localEnv: config.getEnvironment('local'),
    localClient: {} as never, capture: capture as never, ...over,
  } as never);
}

describe('setup reads connectors in the background', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vendorFetch);
    mockGetConnectorFields.mockReturnValue(null);
    mockProve.mockResolvedValue('ok');
    decideSpy.calls = 0;
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('jira: saves the token, starts one child, fetches nothing inline, and says it is deferred', async () => {
    const startSync = vi.fn(async () => ({ ok: true, pid: 1 }));
    const results = await connect({ preselected: ['jira'], seedTokens: JIRA, background: true, startSync });
    expect(mockFetchJira).not.toHaveBeenCalled();
    expect(startSync).toHaveBeenCalledExactlyOnceWith(['jira'], expect.anything());
    expect(mockSaveConnectorFields).toHaveBeenCalledWith('local', 'jira', expect.objectContaining({ token: 'jira-tok' }));
    expect(results).toEqual([expect.objectContaining({ id: 'jira', deferred: true })]);
  });

  it('jira and linear start one child with both', async () => {
    const startSync = vi.fn(async () => ({ ok: true, pid: 1 }));
    await connect({ preselected: ['jira', 'linear'], seedTokens: { ...JIRA }, background: true, startSync });
    expect(mockFetchJira).not.toHaveBeenCalled();
    expect(mockFetchLinear).not.toHaveBeenCalled();
    expect(startSync).toHaveBeenCalledTimes(1);
    expect([...startSync.mock.calls[0]![0]].sort()).toEqual(['jira', 'linear']);
  });

  it('github is still read in the foreground', async () => {
    const startSync = vi.fn(async () => ({ ok: true, pid: 1 }));
    await connect({ preselected: ['github'], seedTokens: { token: 'gh-tok' }, background: true, startSync });
    expect(mockFetchGitHub).toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
  });

  it('a child that cannot start: the sources are read now, after a line saying so', async () => {
    const startSync = vi.fn(async () => ({ ok: false }));
    const results = await connect({ preselected: ['jira'], seedTokens: JIRA, background: true, startSync });
    expect(vi.mocked(p.log.info).mock.calls.map((c) => c[0])).toContain('Could not start the background read, so reading now.');
    expect(mockFetchJira).toHaveBeenCalledTimes(1);
    expect(results).toEqual([expect.objectContaining({ id: 'jira' })]);
    expect(results[0]).not.toHaveProperty('deferred');
  });

  it('without background nothing changes: jira is fetched inline and no child starts', async () => {
    const startSync = vi.fn(async () => ({ ok: true, pid: 1 }));
    await connect({ preselected: ['jira'], seedTokens: JIRA, startSync });
    expect(mockFetchJira).toHaveBeenCalledTimes(1);
    expect(startSync).not.toHaveBeenCalled();
  });

  it('the child starts now, as the launcher', async () => {
    const startSync = vi.fn(async () => ({ ok: true, pid: 1 }));
    await connect({ preselected: ['jira'], seedTokens: JIRA, background: true, startSync });
    expect(startSync.mock.calls[0]![1]).toEqual({ delaySeconds: 0, caller: 'launcher' });
  });

  it('a child that cannot start reads with the scope already decided: the scope step is not asked again', async () => {
    await connect({ preselected: ['jira'], seedTokens: JIRA, background: true, startSync: vi.fn(async () => ({ ok: false })) });
    expect(decideSpy.calls).toBe(0);
    expect(mockFetchJira).toHaveBeenCalledTimes(1);
  });

  it('a token the vendor refuses is not saved, not deferred, and says how to reconnect', async () => {
    mockProve.mockResolvedValue('refused');
    const startSync = vi.fn(async () => ({ ok: true, pid: 1 }));
    const results = await connect({ preselected: ['jira'], seedTokens: JIRA, background: true, startSync });
    expect(mockSaveConnectorFields).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(results).toEqual([expect.objectContaining({ id: 'jira', error: expect.stringContaining('refused') })]);
    expect(vi.mocked(p.log.info).mock.calls.map((c) => String(c[0]))).toContain('Skipped Jira - its token was refused. Paste a fresh one: align connect jira');
  });

  it('a vendor that cannot be reached is not a refusal: the token is saved and read in the background', async () => {
    mockProve.mockResolvedValue('unknown');
    const startSync = vi.fn(async () => ({ ok: true, pid: 1 }));
    await connect({ preselected: ['linear'], seedTokens: { token: 'lin_api_x' }, background: true, startSync });
    expect(mockSaveConnectorFields).toHaveBeenCalledWith('local', 'linear', expect.anything());
    expect(startSync).toHaveBeenCalledWith(['linear'], expect.anything());
  });
});
