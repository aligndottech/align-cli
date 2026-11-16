import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A first-time user who runs `align connect git` before `align` used to read the repo, send every
 * batch, and see "Imported 0 decisions (N batches failed)". Connect now stops before fetching,
 * exits non-zero and names the one command that sets Align up. Drives the real command tree on a
 * fresh HOME with no ALIGN_ENV / ALIGN_TOKEN.
 */
const fetched = vi.hoisted(() => ({ gitHistory: vi.fn(), docs: vi.fn(), ingest: vi.fn() }));
vi.mock('../lib/git.js', () => ({
  isGitRepo: async () => true,
  getCommitHistoryDetailed: fetched.gitHistory,
  getRemoteUrl: async () => 'https://github.com/acme/widgets.git',
  buildCommitUrl: (_r: unknown, sha: string) => `https://github.com/acme/widgets/commit/${sha}`,
  formatCommitAsText: () => 'commit text',
}));
vi.mock('../lib/fetchers/docs.js', () => ({ fetchDocsItems: fetched.docs }));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: fetched.ingest }));

const { registerImportCommand } = await import('../commands/import.js');

const KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'ALIGN_ENV', 'ALIGN_TOKEN', 'ALIGN_GATEWAY_URL', 'ALIGN_TENANT_ID'] as const;
const saved: Record<string, string | undefined> = {};
let home: string;

async function run(argv: string[]): Promise<{ code: number | undefined; err: string }> {
  const errs: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  let code: number | undefined;
  try { await program.parseAsync(argv, { from: 'user' }); } catch (e) {
    const m = /^exit:(\d+)$/.exec((e as Error).message);
    if (!m) throw e;
    code = Number(m[1]);
  }
  exit.mockRestore();
  return { code, err: errs.join('\n') };
}

describe('align connect before Align is set up', () => {
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    home = mkdtempSync(path.join(tmpdir(), 'align-cbs-'));
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    fetched.gitHistory.mockReset().mockResolvedValue({ commits: [], scanned: 0, rejectedByRationale: 0 });
    fetched.docs.mockReset().mockResolvedValue({ items: [] });
    fetched.ingest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(home, { recursive: true, force: true });
  });

  it.each([['git', fetched.gitHistory], ['docs', fetched.docs]])('connect %s stops before fetching, exits 1, says what to run', async (source, fetch) => {
    const { code, err } = await run(['connect', source]);
    expect(code).toBe(1);
    expect(err).toBe('Align is not set up on this machine. Run `align` to set it up.');
    expect(fetch).not.toHaveBeenCalled();
    expect(fetched.ingest).not.toHaveBeenCalled();
  });

  it('is the same for the picker path with --source and --json: one stderr line, nothing on stdout', async () => {
    const out = vi.spyOn(console, 'log');
    const { code, err } = await run(['connect', '--source', 'git', '--json']);
    expect(code).toBe(1);
    expect(err.split('\n')).toHaveLength(1);
    expect(err).toContain('Run `align` to set it up.');
    expect(out).not.toHaveBeenCalled();
  });

  it('connect <source> --help still shows help before setup', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
    const program = new Command();
    program.exitOverride();
    registerImportCommand(program);
    await expect(program.parseAsync(['connect', 'docs', '--help'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
  });

  it('a set-up user (ALIGN_TOKEN) still reaches the fetch', async () => {
    process.env['ALIGN_TOKEN'] = 'tok_test';
    const { err } = await run(['connect', 'git']);
    expect(err).not.toContain('not set up');
    expect(fetched.gitHistory).toHaveBeenCalled();
  });
});
