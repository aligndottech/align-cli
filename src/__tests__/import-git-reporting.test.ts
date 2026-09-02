import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Copilot review (PR #223): `dropped = scanned - commits.length` conflates two different
 * rejection reasons - a commit whose SUBJECT is mechanical (chore/wip/merge/too short,
 * the pre-existing filter) never reaches the rationale gate at all, so folding it into
 * "no rationale in the commit" overstates what ALI-804's new gate actually did. These
 * pin that the spinner message reports only the rationale-gate count, using a shared
 * `stopMock` reference so the message text is inspectable (the inline `@clack/prompts`
 * mock in import-option-collision.test.ts discards a fresh object per call).
 */
const stopMock = vi.fn();
// ALI-827: the capture report prints through console.log, after the import.
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
  getRemoteUrl: vi.fn().mockResolvedValue(null),
  buildCommitUrl: vi.fn(() => 'git://commit/abc123'),
  formatCommitAsText: vi.fn(() => 'commit text'),
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
const { getCommitHistoryDetailed } = await import('../lib/git.js');
const { runPersonalImport } = await import('../lib/personal-import.js');

async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

const commit = { sha: 'a', subject: 'feat: a real decision with a stated reason', body: 'because', author: 'a', date: 'd', filesChanged: [] };

describe('align import git - scanned/kept/dropped reporting (ALI-804 review fix)', () => {
  beforeEach(() => {
    stopMock.mockClear();
    logSpy.mockClear();
    vi.mocked(getCommitHistoryDetailed).mockReset();
  });

  it('reports the rationale-gate drop count, not every commit the shape filter also rejected', async () => {
    // 10 scanned; 5 never reached the rationale gate (chore/wip/merge - the PRE-EXISTING
    // subject filter); only 2 of the remaining 5 failed the NEW rationale gate.
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({
      commits: [commit, commit, commit],
      scanned: 10,
      rejectedByRationale: 2,
    });
    await run(['import', 'git']);
    const message = stopMock.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain('2');
    // The old message reported scanned(10) - kept(3) = 7, which folds in the 5 the
    // subject filter already rejected. That number must not appear.
    expect(message).not.toContain('7');
  });

  it('falls back to the plain message when the rationale gate drops nothing', async () => {
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({
      commits: [commit],
      scanned: 8,
      rejectedByRationale: 0,
    });
    await run(['import', 'git']);
    const message = stopMock.mock.calls.at(-1)?.[0] as string;
    expect(message).toBe('Found 1 commits worth importing');
  });

  // ALI-827 R6a
  it('the capture report names both drop reasons separately, never as one number', async () => {
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({
      commits: [commit, commit, commit],
      scanned: 10,
      rejectedByRationale: 2,
    });
    await run(['import', 'git']);
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('Git: 3 commits');
    expect(printed).toContain('2 commits stated no reason beyond the subject');
    expect(printed).toContain('5 commits with a mechanical');            // 10 - 3 - 2
    expect(printed).not.toContain('7 commits');                         // the conflated number
    // 10 scanned against the default --limit of 500: the repo ran out, not the cap.
    expect(printed).not.toContain('of up to');
  });

  it('the capture report names the cap when the scan reached it', async () => {
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({
      commits: [commit, commit, commit],
      scanned: 10,
      rejectedByRationale: 2,
    });
    await run(['import', 'git', '--limit', '10']);
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('Git: 3 commits of up to 10 requested');
  });

  // ALI-829: the row's decided_at comes from the commit's own date, so the command has to
  // hand it over. `git log --format=%aI` is strict ISO-8601; ingest normalises to Z.
  it('hands each commit date over as created_at, for decided_at', async () => {
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({
      commits: [{ ...commit, date: '2026-01-11T08:30:00+01:00' }],
      scanned: 1,
      rejectedByRationale: 0,
    });
    await run(['import', 'git']);
    const items = vi.mocked(runPersonalImport).mock.calls.at(-1)?.[0] as Array<{ created_at?: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].created_at).toBe('2026-01-11T08:30:00+01:00');
  });

  // ALI-827 R6b
  it('the capture report carries no skip lines when nothing was dropped', async () => {
    vi.mocked(getCommitHistoryDetailed).mockResolvedValue({
      commits: Array.from({ length: 8 }, () => commit),
      scanned: 8,
      rejectedByRationale: 0,
    });
    await run(['import', 'git']);
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('Git: 8 commits');
    expect(printed).not.toContain('stated no reason');
    expect(printed).not.toContain('mechanical subject');
  });
});
