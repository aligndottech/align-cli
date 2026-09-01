import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The parent `import` command and all thirteen of its subcommands each declare
 * `--env`, and the ten personal-import ones also declare `--approve`. Commander
 * resolves that collision in favour of the parent, so the subcommand's own
 * `opts` receives neither:
 *
 *   - `--approve` never skips the confirm, so a non-TTY run (CI, a pipe, an
 *     agent driving the CLI) dies on ERR_TTY_INIT_FAILED.
 *   - `--env local` never routes to the local graph, so a no-account user's
 *     `align import git` - documented "no auth required" - 401s against the
 *     cloud default and their local graph stays empty.
 *
 * These assert the observable behaviour (what the import actually receives and
 * which env it resolves), not the shape of the options object, so they stay
 * honest whichever way the collision is resolved.
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
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCommitHistoryDetailed: vi.fn().mockResolvedValue({ commits: [{ sha: 'abc123', subject: 'feat: a commit' }], scanned: 1 }),
  getRemoteUrl: vi.fn().mockResolvedValue(null),
  buildCommitUrl: vi.fn(() => 'git://commit/abc123'),
  formatCommitAsText: vi.fn(() => 'commit text'),
}));
vi.mock('../lib/fetchers/github.js', () => ({
  fetchGitHubItems: vi.fn().mockResolvedValue([{ source_url: 'u', platform: 'github', raw_text: 't' }]),
}));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'prod'), resolveImportEnv: vi.fn(() => 'prod') }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' })),
    getDefaultEnv: vi.fn(() => 'prod'),
  })),
}));

const { registerImportCommand } = await import('../commands/import.js');
const { runPersonalImport } = await import('../lib/personal-import.js');
const { resolveImportEnv } = await import('../lib/resolve-env.js');

async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

/** The options object `runPersonalImport` was handed on its most recent call. */
function importOpts(): Record<string, unknown> {
  const calls = vi.mocked(runPersonalImport).mock.calls;
  if (!calls.length) throw new Error('runPersonalImport was never called');
  return calls[calls.length - 1]![2] as unknown as Record<string, unknown>;
}

describe('import subcommand options reach the subcommand (parent/child collision)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveImportEnv).mockReturnValue('prod');
  });

  it('honours --approve on `import git`, so the confirm prompt is skipped', async () => {
    await run(['import', 'git', '--approve']);
    expect(importOpts()['approve']).toBe(true);
  });

  // Second example for the same rule: proves this is the parsing, not something
  // special-cased for `git`.
  it('honours --approve on `import github`', async () => {
    await run(['import', 'github', '--token', 'ghp_x', '--approve']);
    expect(importOpts()['approve']).toBe(true);
  });

  it('honours --env local on `import git`, so a no-account user routes locally', async () => {
    await run(['import', 'git', '--env', 'local']);
    expect(resolveImportEnv).toHaveBeenCalledWith('local');
  });

  it('honours --env local on `import github`', async () => {
    await run(['import', 'github', '--token', 'ghp_x', '--env', 'local']);
    expect(resolveImportEnv).toHaveBeenCalledWith('local');
  });

  it('honours --approve and --env together with a child-only option', async () => {
    await run(['import', 'git', '--approve', '--env', 'local', '--limit', '3']);
    expect(importOpts()['approve']).toBe(true);
    expect(resolveImportEnv).toHaveBeenCalledWith('local');
  });

  // Control: a child-only option was never affected by the collision. If this
  // fails, the defect is not the collision.
  it('still passes a child-only option through', async () => {
    const { getCommitHistoryDetailed } = await import('../lib/git.js');
    await run(['import', 'git', '--limit', '7']);
    expect(vi.mocked(getCommitHistoryDetailed)).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));
  });

  // Control: without the flag, approve must stay falsy. Otherwise a fix that
  // simply forces approve on would pass every test above.
  it('leaves approve unset when the flag is absent', async () => {
    await run(['import', 'git']);
    expect(importOpts()['approve']).toBeFalsy();
  });
});
