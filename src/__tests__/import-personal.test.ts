import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ALI-388: `align import <src> --personal` - connect via the Align Personal OAuth apps
 * (browser flow, cached token reuse) instead of pasting a PAT. Plus the regression the
 * wiring exposed: jira/confluence read cached tokens under 'jira'/'confluence' while
 * `align setup` persists them under the source's oauthKey ('jira-personal'/
 * 'confluence-personal'), so the documented "or uses cached OAuth token from align setup"
 * fallback could never fire.
 */

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/fetchers/github.js', () => ({
  fetchGitHubItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'github', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/jira.js', () => ({
  fetchJiraItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'jira', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/confluence.js', () => ({
  fetchConfluenceItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'confluence', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/gitlab.js', () => ({
  fetchGitLabItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'gitlab', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/linear.js', () => ({
  fetchLinearItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'linear', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/notion.js', () => ({
  fetchNotionItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'notion', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/slack.js', () => ({
  fetchSlackItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'slack', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/teams.js', () => ({
  fetchTeamsItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'teams', raw_text: 't' }]),
}));
vi.mock('../lib/fetchers/zoom.js', () => ({
  fetchZoomItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'zoom', raw_text: 't' }]),
}));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: vi.fn() }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'prod'), resolveImportEnv: vi.fn(() => 'prod') }));

// The localhost callback listener: resolve immediately with fresh credentials, invoking
// onBound the way the real server does so startCliOAuth gets the port + nonce.
vi.mock('../lib/cli-oauth.js', () => ({
  CLI_CALLBACK_PORTS: [7654],
  waitForCallback: vi.fn(async (opts: { onBound?: (port: number, nonce: string) => unknown }) => {
    await opts.onBound?.(7654, 'nonce-1');
    return { data: { credentials: { access_token: 'fresh-oauth-tok' } }, port: 7654 };
  }),
}));

const { gatewayClient, configState } = vi.hoisted(() => {
  const configState = {
    tokens: {} as Record<string, string>,
    cloudIds: {} as Record<string, string>,
    siteBases: {} as Record<string, string>,
    env: { gatewayUrl: 'https://api.align.tech', authToken: 'auth-tok', tenantId: 'tid', mode: 'auth' } as Record<string, unknown>,
    setToken: vi.fn(),
  };
  return {
    configState,
    gatewayClient: {
      startCliOAuth: vi.fn(async () => ({ authUrl: 'https://api.align.tech/oauth/x' })),
    },
  };
});
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => gatewayClient) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => configState.env),
    getDefaultEnv: vi.fn(() => 'prod'),
    getConnectorToken: vi.fn((env: string, key: string) => configState.tokens[`${env}:${key}`] ?? null),
    getConnectorCloudId: vi.fn((env: string, key: string) => configState.cloudIds[`${env}:${key}`] ?? null),
    getConnectorSiteBase: vi.fn((env: string, key: string) => configState.siteBases[`${env}:${key}`] ?? null),
    setConnectorToken: configState.setToken,
    setConnectorCloudId: vi.fn(),
    setConnectorSiteBase: vi.fn(),
  })),
}));

const { registerImportCommand } = await import('../commands/import.js');
const { fetchJiraItems } = await import('../lib/fetchers/jira.js');
const { fetchConfluenceItems } = await import('../lib/fetchers/confluence.js');
const { fetchGitHubItems } = await import('../lib/fetchers/github.js');

async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

beforeEach(() => {
  vi.clearAllMocks();
  configState.tokens = {};
  configState.cloudIds = {};
  configState.siteBases = {};
  configState.env = { gatewayUrl: 'https://api.align.tech', authToken: 'auth-tok', tenantId: 'tid', mode: 'auth' };
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

describe('jira/confluence cached-token key matches what align setup persists (the live bug)', () => {
  it('import jira with no flags uses the token setup stored under jira-personal', async () => {
    configState.tokens['prod:jira-personal'] = 'cached-jira-tok';
    configState.cloudIds['prod:jira-personal'] = 'cloud-1';
    configState.siteBases['prod:jira-personal'] = 'https://team.atlassian.net';

    await run(['import', 'jira', '--approve']);

    expect(vi.mocked(fetchJiraItems)).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'cached-jira-tok', cloudId: 'cloud-1', siteBase: 'https://team.atlassian.net' })
    );
  });

  it('import confluence with no flags uses the token setup stored under confluence-personal', async () => {
    configState.tokens['prod:confluence-personal'] = 'cached-conf-tok';
    configState.cloudIds['prod:confluence-personal'] = 'cloud-2';
    configState.siteBases['prod:confluence-personal'] = 'https://team.atlassian.net';

    await run(['import', 'confluence', '--approve']);

    expect(vi.mocked(fetchConfluenceItems)).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'cached-conf-tok', cloudId: 'cloud-2' })
    );
  });
});

describe('align import <src> --personal (ALI-388)', () => {
  it('uses a cached personal token without opening a browser', async () => {
    configState.tokens['prod:github-personal'] = 'cached-gh-tok';

    await run(['import', 'github', '--personal', '--approve']);

    expect(vi.mocked(fetchGitHubItems)).toHaveBeenCalledWith(expect.objectContaining({ token: 'cached-gh-tok' }));
    expect(gatewayClient.startCliOAuth).not.toHaveBeenCalled();
  });

  it('runs the browser OAuth flow when nothing is cached, then imports with the fresh token', async () => {
    await run(['import', 'github', '--personal', '--approve']);

    expect(gatewayClient.startCliOAuth).toHaveBeenCalledWith('github-personal', 7654, 'nonce-1');
    expect(vi.mocked(fetchGitHubItems)).toHaveBeenCalledWith(expect.objectContaining({ token: 'fresh-oauth-tok' }));
    // Persisted for next time, under the key the rest of the CLI reads.
    expect(configState.setToken).toHaveBeenCalledWith('prod', 'github-personal', 'fresh-oauth-tok');
  });

  it('an explicit --token wins over --personal', async () => {
    configState.tokens['prod:github-personal'] = 'cached-gh-tok';

    await run(['import', 'github', '--token', 'ghp_explicit', '--personal', '--approve']);

    expect(vi.mocked(fetchGitHubItems)).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghp_explicit' }));
    expect(gatewayClient.startCliOAuth).not.toHaveBeenCalled();
  });

  it('with neither --token nor --personal, errors naming both options', async () => {
    const p = await import('@clack/prompts');

    await expect(run(['import', 'github', '--approve'])).rejects.toThrow('process.exit:1');

    const message = vi.mocked(p.log.error).mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/--token/);
    expect(message).toMatch(/--personal/);
    expect(vi.mocked(fetchGitHubItems)).not.toHaveBeenCalled();
  });

  it('refuses --personal in local-embedded mode before any browser opens', async () => {
    // authToken deliberately PRESENT: config.getEnvironment injects ALIGN_TOKEN into any env
    // including local, so without it this fixture would satisfy the login guard too and the
    // mode guard would be unpinned (deleting it left this test green until this was fixed).
    configState.env = { mode: 'local-embedded', localDbPath: '/tmp/x.db', authToken: 'auth-tok' };
    const p = await import('@clack/prompts');

    await expect(run(['import', 'github', '--personal'])).rejects.toThrow('process.exit:1');

    expect(gatewayClient.startCliOAuth).not.toHaveBeenCalled();
    const message = vi.mocked(p.log.error).mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/cloud environment/);
  });

  it('refuses --personal when not logged in, pointing at align login', async () => {
    configState.env = { gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' };
    const p = await import('@clack/prompts');

    await expect(run(['import', 'github', '--personal'])).rejects.toThrow('process.exit:1');

    expect(gatewayClient.startCliOAuth).not.toHaveBeenCalled();
    const message = vi.mocked(p.log.error).mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/align login/);
  });

  it('refuses --personal on gitlab with a self-managed --domain (the OAuth app is gitlab.com-only)', async () => {
    await expect(run(['import', 'gitlab', '--personal', '--domain', 'git.corp.example'])).rejects.toThrow('process.exit:1');

    expect(gatewayClient.startCliOAuth).not.toHaveBeenCalled();
  });

  it('jira --personal carries cloudId and siteBase from the cached Atlassian credential', async () => {
    // Pins the creds -> cloudId/siteBase assignment: without it, --personal with a fully
    // cached Atlassian credential would die on "OAuth metadata incomplete".
    configState.tokens['prod:jira-personal'] = 'cached-jira-tok';
    configState.cloudIds['prod:jira-personal'] = 'cloud-1';
    configState.siteBases['prod:jira-personal'] = 'https://team.atlassian.net';

    await run(['import', 'jira', '--personal', '--approve']);

    expect(vi.mocked(fetchJiraItems)).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'cached-jira-tok', cloudId: 'cloud-1', siteBase: 'https://team.atlassian.net' })
    );
    expect(gatewayClient.startCliOAuth).not.toHaveBeenCalled();
  });
});

describe('every OAuth-capable subcommand resolves --personal (the wiring, not just the map)', () => {
  // A typo'd sourceId inside any one subcommand would throw "--personal is not supported"
  // at runtime while the map test stays green - so drive each command end to end.
  it.each([
    ['linear', 'linear-personal', '../lib/fetchers/linear.js', 'fetchLinearItems'],
    ['notion', 'notion-personal', '../lib/fetchers/notion.js', 'fetchNotionItems'],
    ['slack', 'slack-personal', '../lib/fetchers/slack.js', 'fetchSlackItems'],
    ['teams', 'teams', '../lib/fetchers/teams.js', 'fetchTeamsItems'],
    ['zoom', 'zoom', '../lib/fetchers/zoom.js', 'fetchZoomItems'],
  ])('import %s --personal uses the cached %s token', async (source, key, fetcherModule, fetcherName) => {
    configState.tokens[`prod:${key}`] = `cached-${source}-tok`;

    await run(['import', source, '--personal', '--approve']);

    const fetcher = (await import(fetcherModule))[fetcherName] as ReturnType<typeof vi.fn>;
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ token: `cached-${source}-tok` }));
    expect(gatewayClient.startCliOAuth).not.toHaveBeenCalled();
  });
});

describe('the source -> personal OAuth key map', () => {
  it('covers every OAuth-capable import source with the key the gateway expects', async () => {
    const { PERSONAL_OAUTH_KEYS } = await import('../lib/personal-oauth.js');
    expect(PERSONAL_OAUTH_KEYS).toEqual({
      github: 'github-personal',
      gitlab: 'gitlab-personal',
      linear: 'linear-personal',
      notion: 'notion-personal',
      slack: 'slack-personal',
      jira: 'jira-personal',
      confluence: 'confluence-personal',
      // Teams and Zoom have no separate personal app; the CLI OAuth flow uses the org key
      // and the gateway's CLI branch keeps the credentials local either way.
      teams: 'teams',
      zoom: 'zoom',
    });
  });
});
