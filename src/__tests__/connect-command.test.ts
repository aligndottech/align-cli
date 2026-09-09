/**
 * ALI-951: `align connect`. With no source it opens the picker `align setup` already uses
 * (runLocalConnectorPhase's "Connect more sources with a read-only token?"), reused rather
 * than re-implemented. `align connect <source>` is the old `import <source>`. Every prompt
 * has a flag bypass - `--source` for the picker, `--token` for the paste, `--yes` for the
 * confirms - and a run with no terminal and no bypass exits non-zero naming the flag it
 * needed (clig.dev, Heroku). `--json` prints one machine-readable summary.
 */
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
vi.mock('../lib/fetchers/github.js', () => ({
  fetchGitHubItems: mockFetchGitHub,
  resolveGitHubRepoScope: vi.fn().mockResolvedValue(undefined),
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
});
