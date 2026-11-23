/**
 * `align context sync --out <file>`: write the decisions to a file the team names (DECISIONS.md in the root) and import that.
 * Test List:
 * 1. a repo-only graph writes DECISIONS.md at the root, a real file, and CLAUDE.md imports @DECISIONS.md
 * 2. a graph holding anything private refuses --out and writes nothing, since a named file in the repo is one git add from public
 * 3. a path outside the repo, or not a .md file, is refused
 * 4. --limit N caps the decisions in the file
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockListDecisions } = vi.hoisted(() => ({ mockListDecisions: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ listDecisions: mockListDecisions })) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded', gatewayUrl: 'http://localhost:0' })) })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local'), resolveImportEnv: vi.fn(() => 'local') }));
import { registerContextCommand } from '../commands/context.js';

const REPO_ONLY = [
  { id: '2', title: 'ADRs live in docs/adr', summary: '', platform: 'docs', status: 'active', source_url: 'https://github.com/acme/api/blob/main/docs/adr/1.md' },
  { id: '3', title: 'Retry webhooks with backoff instead of failing the event', summary: '', platform: 'github', status: 'active', source_url: 'https://github.com/acme/api/pull/7' },
  { id: '4', title: 'Use Postgres instead of MySQL for the event store', summary: '', platform: 'github', status: 'active', source_url: 'https://github.com/acme/api/pull/8' },
];
const run = (...args: string[]) => { const p = new Command(); p.exitOverride(); registerContextCommand(p); return p.parseAsync(['node', 'align', 'context', 'sync', ...args]); };

let repo: string; let prevCwd: string; let logs: string[]; let errs: string[];
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-out-'));
  prevCwd = process.cwd(); process.chdir(repo);
  logs = []; errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  mockListDecisions.mockReset().mockResolvedValue(REPO_ONLY);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/adr/1.md'), '# ADRs live in docs/adr\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), "# Rules\n\nDon't go against any decisions in DECISIONS.md\n");
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo });
  process.exitCode = undefined;
});
afterEach(() => { process.exitCode = undefined; process.chdir(prevCwd); fs.rmSync(repo, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('align context sync --out', () => {
  it('writes DECISIONS.md at the root as a real file and imports it from CLAUDE.md', async () => {
    await run('--out', 'DECISIONS.md');
    const file = path.join(repo, 'DECISIONS.md');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('Retry webhooks with backoff instead of failing the event');
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toContain('@DECISIONS.md');
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).not.toContain('@.align/decisions.md');
    expect(fs.existsSync(path.join(repo, '.align/decisions.md'))).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('refuses, and writes nothing, when any decision is not from this repo', async () => {
    mockListDecisions.mockResolvedValue([...REPO_ONLY, { id: '9', title: 'Freeze deploys on Fridays', summary: '', platform: 'slack', status: 'active', source_url: 'https://acme.slack.com/archives/C1/p1' }]);
    await run('--out', 'DECISIONS.md');
    expect(fs.existsSync(path.join(repo, 'DECISIONS.md'))).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/DECISIONS\.md.*not from this repo/s);
  });

  it('refuses a path outside the repo, and a file that is not markdown', async () => {
    await run('--out', '../elsewhere.md');
    expect(fs.existsSync(path.join(repo, '../elsewhere.md'))).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await run('--out', 'src/index.ts');
    expect(fs.existsSync(path.join(repo, 'src/index.ts'))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('--limit caps how many decisions the file keeps', async () => {
    await run('--out', 'DECISIONS.md', '--limit', '2');
    const text = fs.readFileSync(path.join(repo, 'DECISIONS.md'), 'utf8');
    expect(text).toContain('ADRs live in docs/adr');
    expect(text).toContain('Retry webhooks with backoff');
    expect(text).not.toContain('Use Postgres instead of MySQL');
  });

  it('refuses to replace a file Align did not write, and leaves it as it was', async () => {
    fs.writeFileSync(path.join(repo, 'DECISIONS.md'), '# Our decisions\n\n- We ship on Tuesdays\n');
    await run('--out', 'DECISIONS.md');
    expect(fs.readFileSync(path.join(repo, 'DECISIONS.md'), 'utf8')).toBe('# Our decisions\n\n- We ship on Tuesdays\n');
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/DECISIONS\.md.*not written by Align/s);
  });

  it.each([['a BOM', '\uFEFF'], ['a leading blank line', '\n'], ['a BOM and blank lines', '\uFEFF\r\n\n']])('replaces a file Align wrote before that an editor gave %s', async (_n, lead) => {
    await run('--out', 'DECISIONS.md');
    const file = path.join(repo, 'DECISIONS.md');
    fs.writeFileSync(file, `${lead}${fs.readFileSync(file, 'utf8')}`);
    await run('--out', 'DECISIONS.md');
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(file, 'utf8').startsWith('# Decisions (generated by Align)')).toBe(true);
  });

  it('replaces a file Align wrote before (a rerun)', async () => {
    await run('--out', 'DECISIONS.md');
    mockListDecisions.mockResolvedValue(REPO_ONLY.slice(0, 2));
    await run('--out', 'DECISIONS.md');
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(path.join(repo, 'DECISIONS.md'), 'utf8')).not.toContain('Use Postgres instead of MySQL');
  });

  it('never writes into CLAUDE.md, which would also make it import itself', async () => {
    const before = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    await run('--out', 'CLAUDE.md');
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(before);
    expect(process.exitCode).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('refuses a path whose folder is a symlink out of the repo', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-out-elsewhere-'));
    fs.symlinkSync(outside, path.join(repo, 'docs-link'));
    await run('--out', 'docs-link/x.md');
    expect(fs.existsSync(path.join(outside, 'x.md'))).toBe(false);
    expect(process.exitCode).toBe(1);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

