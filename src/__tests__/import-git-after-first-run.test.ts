import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A refresh after first run must not bring back the squash commit of a PR first run stored.
 * Copilot review (PR #223): `dropped = scanned - commits.length` conflates two different
 * rejection reasons - a commit whose SUBJECT is mechanical (chore/wip/merge/too short,
 * the pre-existing filter) never reaches the rationale gate at all, so folding it into
 * "no rationale in the commit" overstates what the new gate actually did. These
 * pin that the spinner message reports only the rationale-gate count, using a shared
 * `stopMock` reference so the message text is inspectable (the inline `@clack/prompts`
 * mock in import-option-collision.test.ts discards a fresh object per call).
 */
const stopMock = vi.fn();
// The capture report prints through console.log, after the import.
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: stopMock, message: vi.fn() }),
}));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCommitHistoryDetailed: vi.fn(),
  getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/Acme/Widgets.git'),
  buildCommitUrl: vi.fn((_r: unknown, sha: string) => `https://github.com/acme/widgets/commit/${sha}`),
  formatCommitAsText: vi.fn(() => 'commit text'),
}));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'prod'), resolveImportEnv: vi.fn(() => 'prod') }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'local-embedded', localDbPath: '/tmp/x.db' })),
    getDefaultEnv: vi.fn(() => 'prod'),
  })),
}));

const stored = vi.hoisted(() => ({ rows: [] as Array<{ platform: string; sourceUrl: string | null }> }));
vi.mock('../lib/local-db.js', () => ({ createLocalDb: vi.fn(() => ({ listDecisions: () => stored.rows, close: vi.fn() })) }));
const { registerImportCommand } = await import('../commands/import.js');
const { getCommitHistoryDetailed } = await import('../lib/git.js');
const { runPersonalImport } = await import('../lib/personal-import.js');

async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}
const c = (sha: string, subject: string) => ({ sha, subject, body: 'because', author: 'a', date: '2026-01-01T00:00:00Z', filesChanged: [] });

describe('align connect git after first run read PR descriptions', () => {
  beforeEach(() => { vi.mocked(getCommitHistoryDetailed).mockReset(); vi.mocked(runPersonalImport).mockReset(); logSpy.mockClear(); });

  it('does not import the squash commit of a stored PR, and says so', async () => {
    stored.rows = [{ platform: 'github', sourceUrl: 'https://github.com/acme/widgets/pull/7' }, { platform: 'github', sourceUrl: 'https://github.com/acme/widgets/issues/8' }];
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({ commits: [c('1'.repeat(40), 'fix a (#7)'), c('2'.repeat(40), 'fix b (#8)'), c('3'.repeat(40), 'fix c')], scanned: 3, rejectedByRationale: 0 });
    await run(['connect', 'git']);
    const items = vi.mocked(runPersonalImport).mock.calls[0]![0] as Array<{ title: string }>;
    expect(items.map((i) => i.title)).toEqual(['fix b (#8)', 'fix c']);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('1 commits that are the squash of a PR already in your graph');
  });

  it('imports every commit when the graph holds no PR rows', async () => {
    stored.rows = [{ platform: 'git', sourceUrl: `https://github.com/acme/widgets/commit/${'9'.repeat(40)}` }];
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({ commits: [c('1'.repeat(40), 'fix a (#7)')], scanned: 1, rejectedByRationale: 0 });
    await run(['connect', 'git']);
    expect((vi.mocked(runPersonalImport).mock.calls[0]![0] as unknown[]).length).toBe(1);
  });
});
