import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ALI-917: `align import github`'s --repo/--all wiring. resolveGitHubRepoScope's own
 * decision logic (auto-detect, --repo, --all) is unit-tested in
 * fetchers/github-repo-scope.test.ts; this only checks the command threads its result
 * (or omits `repo` entirely, for connector-core's unscoped default) into fetchGitHubItems,
 * and surfaces the scope in the pre-fetch status line so the confusion a reporting user
 * hit ("Found 250 items" from unrelated repos, with no visible reason why) is visible up
 * front rather than silent.
 *
 * Test List:
 * 1. a scoped result flows through to fetchGitHubItems as `repo`
 * 2. an unscoped result (undefined) means `repo` is ABSENT from the options object, not
 *    merely undefined - a fetcher checking `'repo' in opts` must see the same "no
 *    opinion" it saw before this ticket
 * 3. --repo and --all both reach resolveGitHubRepoScope's opts, unchanged by the command
 * 4. the pre-fetch status line names the repo when scoped
 * 5. the pre-fetch status line points at --repo when unscoped
 */

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
  spinner: () => ({ start: spinnerStart, stop: vi.fn(), message: vi.fn() }),
}));
const spinnerStart = vi.hoisted(() => vi.fn());

const fetchGitHubItems = vi.hoisted(() => vi.fn());
const resolveGitHubRepoScope = vi.hoisted(() => vi.fn());
vi.mock('../lib/fetchers/github.js', () => ({ fetchGitHubItems, resolveGitHubRepoScope }));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));
vi.mock('../lib/resolve-env.js', () => ({ resolveImportEnv: vi.fn(() => 'prod') }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' })),
  })),
}));

const { registerImportGitHubCommand } = await import('../commands/import/github.js');

async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const importCmd = program.command('import');
  registerImportGitHubCommand(importCmd);
  await program.parseAsync(['import', ...argv], { from: 'user' });
}

/** The options object fetchGitHubItems was called with. */
function fetchOpts(): Record<string, unknown> {
  const calls = vi.mocked(fetchGitHubItems).mock.calls;
  if (!calls.length) throw new Error('fetchGitHubItems was never called');
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

describe('align import github: repo scope wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGitHubItems.mockResolvedValue({
      items: [{ source_url: 'u', platform: 'github', raw_text: 't' }],
      report: { scanned: 1, skips: [] },
    });
  });

  it('a scoped resolution flows through to fetchGitHubItems as repo', async () => {
    resolveGitHubRepoScope.mockResolvedValue('doitintl/kube-no-trouble');
    await run(['github', '--token', 'ghp_x']);
    expect(fetchOpts()['repo']).toBe('doitintl/kube-no-trouble');
  });

  it('an unscoped resolution means repo is ABSENT, not merely undefined', async () => {
    resolveGitHubRepoScope.mockResolvedValue(undefined);
    await run(['github', '--token', 'ghp_x']);
    expect('repo' in fetchOpts()).toBe(false);
  });

  it('passes --repo and --all through to resolveGitHubRepoScope unchanged', async () => {
    resolveGitHubRepoScope.mockResolvedValue('someone-else/other-repo');
    await run(['github', '--token', 'ghp_x', '--repo', 'someone-else/other-repo', '--all']);
    expect(resolveGitHubRepoScope).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'someone-else/other-repo', all: true }),
    );
  });

  it('the pre-fetch status line names the repo when scoped', async () => {
    resolveGitHubRepoScope.mockResolvedValue('doitintl/kube-no-trouble');
    await run(['github', '--token', 'ghp_x']);
    expect(spinnerStart).toHaveBeenCalledWith(expect.stringContaining('doitintl/kube-no-trouble'));
  });

  it('the pre-fetch status line points at --repo when unscoped', async () => {
    resolveGitHubRepoScope.mockResolvedValue(undefined);
    await run(['github', '--token', 'ghp_x']);
    expect(spinnerStart).toHaveBeenCalledWith(expect.stringContaining('--repo'));
  });
});
