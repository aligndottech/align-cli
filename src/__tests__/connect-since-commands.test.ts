import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L3: `--since` on every `align connect <source>` subcommand. Every connector reads the same
 * default window (180 days), its ceiling from the one table, and the shared time budget; `all`
 * drops the lower bound; anything unparseable exits 2 naming the accepted forms and reads nothing.
 */
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), note: vi.fn(), confirm: vi.fn(), isCancel: () => false,
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

const SOURCES = ['github', 'gitlab', 'jira', 'confluence', 'slack', 'teams', 'zoom', 'linear', 'notion'] as const;
const fetchers = vi.hoisted(() => ({
  github: vi.fn(), gitlab: vi.fn(), jira: vi.fn(), confluence: vi.fn(), slack: vi.fn(),
  teams: vi.fn(), zoom: vi.fn(), linear: vi.fn(), notion: vi.fn(),
}));
const resolveRepo = vi.hoisted(() => vi.fn());
vi.mock('../lib/fetchers/github.js', () => ({ fetchGitHubItems: fetchers.github, resolveGitHubRepoScope: resolveRepo }));
vi.mock('../lib/fetchers/gitlab.js', () => ({ fetchGitLabItems: fetchers.gitlab }));
vi.mock('../lib/fetchers/jira.js', () => ({ fetchJiraItems: fetchers.jira }));
vi.mock('../lib/fetchers/confluence.js', () => ({ fetchConfluenceItems: fetchers.confluence }));
vi.mock('../lib/fetchers/slack.js', () => ({ fetchSlackItems: fetchers.slack }));
vi.mock('../lib/fetchers/teams.js', () => ({ fetchTeamsItems: fetchers.teams }));
vi.mock('../lib/fetchers/zoom.js', () => ({ fetchZoomItems: fetchers.zoom }));
vi.mock('../lib/fetchers/linear.js', () => ({ fetchLinearItems: fetchers.linear }));
vi.mock('../lib/fetchers/notion.js', () => ({ fetchNotionItems: fetchers.notion }));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));
vi.mock('../lib/resolve-env.js', () => ({ resolveImportEnv: vi.fn(() => 'prod') }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' })),
    getConnectorToken: vi.fn(() => null), getConnectorCloudId: vi.fn(() => null), getConnectorSiteBase: vi.fn(() => null),
  })),
}));

const loaders = {
  github: async () => (await import('../commands/import/github.js')).registerImportGitHubCommand,
  gitlab: async () => (await import('../commands/import/gitlab.js')).registerImportGitLabCommand,
  jira: async () => (await import('../commands/import/jira.js')).registerImportJiraCommand,
  confluence: async () => (await import('../commands/import/confluence.js')).registerImportConfluenceCommand,
  slack: async () => (await import('../commands/import/slack.js')).registerImportSlackCommand,
  teams: async () => (await import('../commands/import/teams.js')).registerImportTeamsCommand,
  zoom: async () => (await import('../commands/import/zoom.js')).registerImportZoomCommand,
  linear: async () => (await import('../commands/import/linear.js')).registerImportLinearCommand,
  notion: async () => (await import('../commands/import/notion.js')).registerImportNotionCommand,
} as const;
const AUTH: Record<string, string[]> = {
  jira: ['--token', 't', '--email', 'e@x.io', '--domain', 'x.atlassian.net'],
  confluence: ['--token', 't', '--email', 'e@x.io', '--domain', 'x.atlassian.net'],
};
const NOW = new Date('2026-10-10T12:00:00.000Z');

async function run(id: (typeof SOURCES)[number], extra: string[]): Promise<void> {
  const register = await loaders[id]();
  const program = new Command();
  program.exitOverride();
  const importCmd = program.command('connect');
  register(importCmd);
  await program.parseAsync(['connect', id, ...(AUTH[id] ?? ['--token', 't']), ...extra], { from: 'user' });
}
const opts = (id: (typeof SOURCES)[number]) => fetchers[id].mock.calls.at(-1)![0] as Record<string, unknown>;

let out: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  resolveRepo.mockReset().mockResolvedValue(undefined);
  for (const id of SOURCES) fetchers[id].mockReset().mockResolvedValue({ items: [{ source_url: 'u', platform: id, raw_text: 't' }], report: { scanned: 1, skips: [], complete: true } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(SOURCES)('align connect %s --since', (id) => {
  it('defaults to the last 180 days, the source ceiling and the shared time budget', async () => {
    await run(id, []);
    expect(opts(id)).toMatchObject({ since: '2026-04-13T12:00:00.000Z', timeBudgetMs: 480_000 });
    expect(opts(id)['limit']).toBeGreaterThanOrEqual(200);
  });

  it('--since 30d reads 30 days back', async () => {
    await run(id, ['--since', '30d']);
    expect(opts(id)['since']).toBe('2026-09-10T12:00:00.000Z');
  });

  it('--since all sends no lower bound at all (the key is absent, not undefined)', async () => {
    await run(id, ['--since', 'all']);
    expect('since' in opts(id)).toBe(false);
  });

  it('--since 6x exits 2 naming the accepted forms and reads nothing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(run(id, ['--since', '6x'])).rejects.toThrow('exit 2');
    expect(exit).toHaveBeenCalledWith(2);
    expect(out.join('\n')).toContain('30d, 2w, 6m, 1y or all');
    expect(fetchers[id]).not.toHaveBeenCalled();
  });

  it('prints the honest line: what it imported over which window', async () => {
    await run(id, ['--since', '6m']);
    expect(out.join('\n')).toMatch(/imported 1 .* from the last 6 months/);
  });
});

describe('the explicit --limit still wins over the ceiling', () => {
  it('github --limit 40', async () => {
    await run('github', ['--limit', '40']);
    expect(opts('github')['limit']).toBe(40);
  });
});

describe('slack keeps --days-back as a deprecated spelling of --since', () => {
  it('--days-back 14 reads 14 days back', async () => {
    await run('slack', ['--days-back', '14']);
    expect(opts('slack')['since']).toBe('2026-09-26T12:00:00.000Z');
    expect('daysBack' in opts('slack')).toBe(false);
  });

  it('--since wins when both are given', async () => {
    await run('slack', ['--days-back', '14', '--since', '30d']);
    expect(opts('slack')['since']).toBe('2026-09-10T12:00:00.000Z');
  });
});

describe('github: items first, whole repo when there is a repo', () => {
  it('reads items only (discussion: none) so the first import is fast, repo or not', async () => {
    await run('github', []);
    expect(opts('github')['discussion']).toBe('none');
  });

  it('inside a repo asks for team scope with that repo (Decision 7)', async () => {
    resolveRepo.mockResolvedValue('o/r');
    await run('github', []);
    expect(opts('github')).toMatchObject({ repo: 'o/r', scope: 'team' });
  });

  it('outside a repo (or with --all) stays the caller\'s own: neither repo nor scope is sent', async () => {
    await run('github', ['--all']);
    expect('repo' in opts('github')).toBe(false);
    expect('scope' in opts('github')).toBe(false);
  });

  it('says discussion is coming, when items are waiting for it', async () => {
    fetchers.github.mockResolvedValue({ items: [{ source_url: 'u', platform: 'github', raw_text: 't' }], report: { scanned: 1, skips: [], complete: true, discussionPending: 1 } });
    await run('github', []);
    expect(out.join('\n')).toContain('discussion is being added in the background');
  });
});
