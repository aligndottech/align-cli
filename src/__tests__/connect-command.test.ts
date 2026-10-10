/**
 * ALI-951: `align connect`. With no source it opens the picker `align setup` already uses
 * (runLocalConnectorPhase's "Connect more sources with a read-only token?"), reused rather
 * than re-implemented. `align connect <source>` is the old `import <source>`. Every prompt
 * has a flag bypass - `--source` for the picker, `--token` for the paste, `--yes` for the
 * confirms - and a run with no terminal and no bypass exits non-zero naming the flag it
 * needed (clig.dev, Heroku). `--json` prints one machine-readable summary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../lib/fetchers/jira.js', () => ({ fetchJiraItems: mockFetchJira }));
for (const m of ['linear', 'confluence', 'slack', 'teams', 'zoom', 'gitlab', 'notion', 'docs', 'git']) {
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

const mockGetConnectorFields = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockSaveConnectorFields = vi.hoisted(() => vi.fn());
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://localhost', authToken: null, tenantId: null, mode: 'local-embedded', localDbPath: '/tmp/local.db' })),
    getDefaultEnv: vi.fn(() => 'prod'),
    getConnectorFields: mockGetConnectorFields,
    saveConnectorFields: mockSaveConnectorFields,
    forgetConnector: vi.fn(),
    getConnectorToken: vi.fn(() => null),
    getConnectorCloudId: vi.fn(() => null),
    getConnectorSiteBase: vi.fn(() => null),
  })),
}));

const stdout: string[] = [];
const stderr: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });

const { registerImportCommand } = await import('../commands/import.js');

async function run(argv: string[]): Promise<number | undefined> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  let code: number | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`process.exit(${c})`);
  }) as never);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  } finally {
    exit.mockRestore();
  }
  return code;
}

function setTty(stdin: boolean, out: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: out, configurable: true });
}

describe('align connect (ALI-951)', () => {
  const inTty = process.stdin.isTTY, outTty = process.stdout.isTTY;
  beforeEach(() => {
    stdout.length = 0;
    stderr.length = 0;
    vi.clearAllMocks();
    mockMultiselect.mockResolvedValue([]);
    mockPassword.mockResolvedValue('pasted-token');
    mockConfirm.mockResolvedValue(true);
    mockGetConnectorFields.mockReturnValue(null);
    mockResolveImportEnv.mockReturnValue('local');
  });
  afterEach(() => setTty(Boolean(inTty), Boolean(outTty)));

  it('with no source at a terminal, opens the multiselect setup uses and imports what was picked', async () => {
    setTty(true, true);
    mockMultiselect.mockResolvedValueOnce(['github']);
    await run(['connect']);
    expect(mockMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Connect more sources with a read-only token?') }),
    );
    expect(mockFetchGitHub).toHaveBeenCalledWith(expect.objectContaining({ token: 'pasted-token' }));
    expect(mockRunPersonalImport).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ label: 'GitHub', local: true }));
    expect(mockSaveConnectorFields).toHaveBeenCalledWith('local', 'github', expect.objectContaining({ token: 'pasted-token' }));
  });

  it('`connect jira` does what `import jira` did', async () => {
    setTty(true, true);
    await run(['connect', 'jira', '--email', 'e@x', '--token', 't', '--domain', 'x.atlassian.net', '--approve']);
    expect(mockFetchJira).toHaveBeenCalledWith(expect.objectContaining({ token: 't', domain: 'x.atlassian.net' }));
    expect(mockMultiselect).not.toHaveBeenCalled();
  });

  describe('every prompt has a flag bypass, and a run with no terminal names the one it needed', () => {
    it('no terminal and no --source: exits non-zero naming --source, and prompts nothing', async () => {
      setTty(false, false);
      const code = await run(['connect']);
      expect(code).not.toBe(0);
      expect(code).toBeDefined();
      expect(stderr.join('\n')).toContain('--source');
      expect(mockMultiselect).not.toHaveBeenCalled();
    });

    it('no terminal, --source github but no --token and nothing saved: exits naming --token', async () => {
      setTty(false, false);
      const code = await run(['connect', '--source', 'github']);
      expect(code).not.toBe(0);
      expect(code).toBeDefined();
      expect(stderr.join('\n')).toContain('--token');
      expect(mockPassword).not.toHaveBeenCalled();
      expect(mockFetchGitHub).not.toHaveBeenCalled();
    });

    it('--source github --token T --yes with no terminal runs the import with no prompt at all', async () => {
      setTty(false, false);
      const code = await run(['connect', '--source', 'github', '--token', 'ghp_from_flag', '--yes']);
      expect(code).toBeUndefined();
      expect(mockMultiselect).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockFetchGitHub).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghp_from_flag' }));
      expect(mockSaveConnectorFields).toHaveBeenCalledWith('local', 'github', expect.objectContaining({ token: 'ghp_from_flag' }));
    });

    it('--yes skips the re-import confirm for a source with a saved token (the second prompt)', async () => {
      setTty(true, true);
      mockGetConnectorFields.mockImplementation((_env: string, id: string) => (id === 'github' ? { token: 'saved-token' } : null));
      await run(['connect', '--source', 'github', '--yes']);
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();
      expect(mockFetchGitHub).toHaveBeenCalledWith(expect.objectContaining({ token: 'saved-token' }));
    });

    // Copilot review, #283: --token with no --source seeds every source the interactive
    // multiselect picks (setup.ts's connectLocalSources applies one seedTokens value to
    // every preselected id); --json with no --source would print one summary per picked
    // source against a contract documented as one document. Both need --source to mean
    // anything, so both are refused before the picker runs, at a real terminal too - the
    // no-terminal cases above only prove the narrower "no --source at all" rule.
    it('at a terminal, --token with no --source: exits non-zero naming --source, before any prompt', async () => {
      setTty(true, true);
      const code = await run(['connect', '--token', 'ghp_x']);
      expect(code).not.toBe(0);
      expect(code).toBeDefined();
      expect(stderr.join('\n')).toContain('--source');
      expect(mockMultiselect).not.toHaveBeenCalled();
    });

    it('at a terminal, --json with no --source: exits non-zero naming --source, before any prompt', async () => {
      setTty(true, true);
      const code = await run(['connect', '--json']);
      expect(code).not.toBe(0);
      expect(code).toBeDefined();
      expect(stderr.join('\n')).toContain('--source');
      expect(mockMultiselect).not.toHaveBeenCalled();
    });
  });

  describe('--json', () => {
    it('prints one JSON summary naming the source, what it found and what was imported', async () => {
      setTty(false, false);
      mockRunPersonalImport.mockResolvedValueOnce(1);
      await run(['connect', '--source', 'github', '--token', 'ghp_x', '--yes', '--json']);
      const jsonLines = stdout.filter((l) => l.trim().startsWith('{'));
      expect(jsonLines).toHaveLength(1);
      const parsed = JSON.parse(jsonLines[0]!) as { env: string; sources: Array<{ id: string; found: number; imported: number }> };
      expect(parsed.env).toBe('local');
      expect(parsed.sources).toEqual([expect.objectContaining({ id: 'github', found: 1, imported: 1 })]);
    });

    it('with a source subcommand is refused, naming the form that supports it', async () => {
      setTty(true, true);
      const code = await run(['connect', 'jira', '--json']);
      expect(code).not.toBe(0);
      expect(code).toBeDefined();
      expect(stderr.join('\n')).toContain('--source jira --json');
      expect(mockFetchJira).not.toHaveBeenCalled();
    });
  });

  // L3: --since on the picker/--source path and on the real parent (a parent flag is awarded to
  // the parent, so the subcommand must read it back through optsWithGlobals).
  describe('--since (L3)', () => {
    const daysAgo = (iso: unknown) => Math.round((Date.now() - Date.parse(String(iso))) / 86_400_000);

    it('--source github --since 30d reads 30 days back, and the report line says so', async () => {
      setTty(false, false);
      await run(['connect', '--source', 'github', '--token', 't', '--yes', '--since', '30d']);
      expect(daysAgo(mockFetchGitHub.mock.calls.at(-1)![0].since)).toBe(30);
      expect(stdout.join('\n')).toContain('from the last 30 days');
    });

    it('--source github with no --since reads the plan default, 180 days', async () => {
      setTty(false, false);
      await run(['connect', '--source', 'github', '--token', 't', '--yes']);
      expect(daysAgo(mockFetchGitHub.mock.calls.at(-1)![0].since)).toBe(180);
      expect(stdout.join('\n')).toContain('from the last 180 days');
    });

    it('--since all sends no lower bound', async () => {
      setTty(false, false);
      await run(['connect', '--source', 'github', '--token', 't', '--yes', '--since', 'all']);
      expect('since' in mockFetchGitHub.mock.calls.at(-1)![0]).toBe(false);
    });

    it('the subcommand form reads the parent\'s flag: connect github --since 2w', async () => {
      setTty(true, true);
      await run(['connect', 'github', '--token', 't', '--approve', '--since', '2w']);
      expect(daysAgo(mockFetchGitHub.mock.calls.at(-1)![0].since)).toBe(14);
    });

    it('the hosted scan (--all, or a cloud env) has its own --from/--to, so --since there is refused, not ignored', async () => {
      setTty(false, false);
      mockResolveImportEnv.mockReturnValue('prod');
      const code = await run(['connect', '--all', '--since', '30d']);
      expect(code).toBe(2);
      expect(stderr.join('\n')).toContain('--from');
    });

    it.each([
      ['--source github --token t --yes', ['connect', '--source', 'github', '--token', 't', '--yes', '--since', '6x']],
      ['the subcommand form', ['connect', 'github', '--token', 't', '--approve', '--since', '-3d']],
    ])('a bad value exits 2 naming the accepted forms and reads nothing (%s)', async (_n, argv) => {
      setTty(false, false);
      const code = await run(argv);
      expect(code).toBe(2);
      expect(stderr.join('\n')).toContain('30d, 2w, 6m, 1y or all');
      expect(mockFetchGitHub).not.toHaveBeenCalled();
    });
  });

  // L3 review 4 and 5 on the --source path.
  describe('what the report claims (L3 review)', () => {
    beforeEach(() => { setTty(false, false); });

    it('says imported X of N when a batch failed, not the fetched count', async () => {
      mockFetchGitHub.mockResolvedValueOnce({
        items: [{ source_url: 'u1', platform: 'github', raw_text: 'a' }, { source_url: 'u2', platform: 'github', raw_text: 'b' }],
        report: { scanned: 2, skips: [], complete: true },
      });
      mockRunPersonalImport.mockImplementationOnce(async (_i: unknown, _c: unknown, o: { result: { stored: number; failedBatches: number } }) => {
        o.result.stored = 1; o.result.failedBatches = 1; return 1;
      });
      await run(['connect', '--source', 'github', '--token', 't', '--yes']);
      expect(stdout.join('\n')).toContain('imported 1 of 2 PRs and issues (a batch failed)');
    });

    it('an import that THROWS leaves no "imported N" claim: it reports 0 of N and a failure', async () => {
      mockFetchGitHub.mockResolvedValueOnce({
        items: [{ source_url: 'u1', platform: 'github', raw_text: 'a' }, { source_url: 'u2', platform: 'github', raw_text: 'b' }],
        report: { scanned: 2, skips: [], complete: true },
      });
      mockRunPersonalImport.mockRejectedValueOnce(new Error('gateway down'));
      await run(['connect', '--source', 'github', '--token', 't', '--yes']);
      const out = stdout.join('\n');
      expect(out).toContain('imported 0 of 2 PRs and issues (a batch failed)');
      expect(out).not.toMatch(/imported 2 /);
    });

    it('prints the team scope line when the read was team scope', async () => {
      mockFetchGitHub.mockResolvedValueOnce({
        items: [{ source_url: 'u1', platform: 'github', raw_text: 'a' }],
        report: { scanned: 1, skips: [], complete: true, scope: 'team', scopeNote: "everyone's PRs and issues in o/r, as far as your token can see" },
      });
      await run(['connect', '--source', 'github', '--token', 't', '--yes']);
      expect(stdout.join('\n')).toContain("reads everyone's PRs and issues in o/r, as far as your token can see");
    });

    it('asks the fetcher for team scope on the local graph', async () => {
      mockResolveRepo.mockResolvedValueOnce('o/r');
      await run(['connect', '--source', 'github', '--token', 't', '--yes']);
      expect(mockFetchGitHub.mock.calls.at(-1)![0]).toMatchObject({ repo: 'o/r', scope: 'team' });
    });
  });

  // Re-review C: a background run that could not read its source must not end "done".
  describe('how a backfill child ends (L3 re-review)', () => {
    let stateDir: string;
    const saved: Record<string, string | undefined> = {};
    beforeEach(async () => {
      setTty(false, false);
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-child-'));
      for (const k of ['XDG_STATE_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'ALIGN_BACKFILL_STATUS']) saved[k] = process.env[k];
      process.env['XDG_STATE_HOME'] = stateDir; process.env['HOME'] = stateDir; process.env['USERPROFILE'] = stateDir; process.env['LOCALAPPDATA'] = stateDir;
      const { backfillDir, statusPath } = await import('../lib/backfill-state.js');
      process.env['ALIGN_BACKFILL_STATUS'] = statusPath(backfillDir()!, 'github');
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      process.exitCode = undefined;
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it('a rejected token: non-zero exit, final state failed, last_line is the error, and the next call says so', async () => {
      mockFetchGitHub.mockRejectedValueOnce(new Error('GitHub authentication failed (401)'));
      await run(['connect', '--env', 'local', '--source', 'github', '--token', 'bad', '--yes', '--json']);
      expect(process.exitCode).toBe(1);
      const { trackChildFromEnv, readStatus, backfillDir, statusPath } = await import('../lib/backfill-state.js');
      trackChildFromEnv()!.finish(process.exitCode ?? 0); // what the process 'exit' handler does
      const status = readStatus(statusPath(backfillDir()!, 'github'));
      expect(status).toMatchObject({ state: 'failed', exit_code: 1 });
      expect(status!.last_line).toContain('github: GitHub authentication failed (401)');

      const { runBackfill, defaultBackfillDeps } = await import('../lib/mcp-backfill.js');
      const env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: '/x' } as never;
      const reply = await runBackfill({ source: 'github' }, env, { ...defaultBackfillDeps(env), isConnected: () => false });
      expect(reply.text).toContain('Last run failed: github: GitHub authentication failed (401)');
    });

    it('a run that worked ends done with exit code 0 and says what it did', async () => {
      await run(['connect', '--env', 'local', '--source', 'github', '--token', 't', '--yes', '--json']);
      expect(process.exitCode).toBeUndefined();
      const { trackChildFromEnv, readStatus, backfillDir, statusPath } = await import('../lib/backfill-state.js');
      trackChildFromEnv()!.finish(0);
      expect(readStatus(statusPath(backfillDir()!, 'github'))).toMatchObject({ state: 'done', exit_code: 0, last_line: expect.stringContaining('github: found 1') });
    });

    it('an interactive connect (no backfill status in the environment) keeps its exit code even when a source fails', async () => {
      delete process.env['ALIGN_BACKFILL_STATUS'];
      mockFetchGitHub.mockRejectedValueOnce(new Error('boom'));
      await run(['connect', '--env', 'local', '--source', 'github', '--token', 'bad', '--yes', '--json']);
      expect(process.exitCode).toBeUndefined();
    });
  });
});
