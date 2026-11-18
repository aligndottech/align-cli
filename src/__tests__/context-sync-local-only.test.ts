/**
 * `align context sync` and where its file may go. A local graph is private to the machine, so the file it feeds
 * stays out of git; a team graph's file is team content and is left alone. Two examples per side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockListDecisions, state } = vi.hoisted(() => ({ mockListDecisions: vi.fn(), state: { mode: 'local-embedded' } }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ listDecisions: mockListDecisions })) }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: state.mode, gatewayUrl: 'http://localhost:0' })) })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local'), resolveImportEnv: vi.fn(() => 'local') }));
import { registerContextCommand } from '../commands/context.js';

// From a chat: content the repo does not already hold, so the file must stay out of git.
const DECISIONS = [{ id: '1', title: 'Use Postgres 16', summary: '', platform: 'slack', status: 'active', source_url: 'https://acme.slack.com/archives/C1/p1' }];
const run = () => { const p = new Command(); p.exitOverride(); registerContextCommand(p); return p.parseAsync(['node', 'align', 'context', 'sync']); };

let repo: string; let prevCwd: string; let logs: string[];
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-sync-lo-'));
  prevCwd = process.cwd(); process.chdir(repo);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  mockListDecisions.mockReset().mockResolvedValue(DECISIONS);
  state.mode = 'local-embedded';
});
afterEach(() => { process.chdir(prevCwd); fs.rmSync(repo, { recursive: true, force: true }); vi.restoreAllMocks(); });
const gitignore = () => (fs.existsSync(path.join(repo, '.gitignore')) ? fs.readFileSync(path.join(repo, '.gitignore'), 'utf8') : null);

describe('align context sync, local graph', () => {
  it('writes the file and adds it to .gitignore, and says why and where sharing goes', async () => {
    await run();
    expect(fs.existsSync(path.join(repo, '.align/decisions.md'))).toBe(true);
    expect(gitignore()).toContain('.align/decisions.md');
    expect(logs.join('\n')).toMatch(/Kept out of git.*local graph/s);
    expect(logs.join('\n')).toMatch(/align share/);
  });

  it('a second run changes nothing more in .gitignore', async () => {
    await run();
    const first = gitignore();
    await run();
    expect(gitignore()).toBe(first);
  });

  it('warns, with the command to stop tracking it, when the file is already committed', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.mkdirSync(path.join(repo, '.align'));
    fs.writeFileSync(path.join(repo, '.align/decisions.md'), 'old');
    execFileSync('git', ['add', '-f', '.align/decisions.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x'], { cwd: repo });
    await run();
    expect(logs.join('\n')).toMatch(/already tracked by git.*git rm --cached \.align\/decisions\.md/s);
  });

  it('a file that is not tracked gets no tracking warning', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await run();
    expect(logs.join('\n')).not.toMatch(/already tracked/);
  });

  it.skipIf(process.platform === 'win32')(
    '.align/decisions.md is a SYMLINK pointing outside the repo, not a real file - gitignore is belt-and-suspenders, not the only protection',
    async () => {
      await run();
      const local = path.join(repo, '.align/decisions.md');
      expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
      expect(path.resolve(path.dirname(local), fs.readlinkSync(local)).startsWith(repo)).toBe(false);
      // The gitignore/tracked-by-git messaging above still fires unchanged - this is the same
      // run as the first test in this describe block, just asserting the on-disk mechanism too.
      expect(fs.readFileSync(local, 'utf8')).toContain('Use Postgres 16');
    },
  );
});

// A local graph built only from the repo itself (its commits, docs and pull requests) holds nothing the repo does
// not already hold, so its decisions file is a normal file the person can commit. Anything from outside (a chat,
// a ticket, an agent session, a hand capture) keeps the file out of git, as above.
describe('align context sync, local graph built only from the repo', () => {
  const REPO_ONLY = [
    { id: '1', title: 'Use Postgres 16', summary: '', platform: 'git', status: 'active', source_url: 'https://github.com/acme/api/commit/abc1234' },
    { id: '2', title: 'ADRs live in docs/adr', summary: '', platform: 'docs', status: 'active', source_url: 'https://github.com/acme/api/blob/main/docs/adr/1.md' },
    { id: '3', title: 'Retry webhooks with backoff instead of failing the event', summary: '', platform: 'github', status: 'active', source_url: 'https://github.com/acme/api/pull/7' },
  ];

  // The repo IS acme/api, and the doc the docs row came from is committed: that is what "from this repo" has to mean.
  beforeEach(() => {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'docs/adr'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs/adr/1.md'), '# ADRs live in docs/adr\n');
    execFileSync('git', ['add', 'docs/adr/1.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'adr'], { cwd: repo });
  });

  it('a pull request from ANOTHER repo keeps the file out of git', async () => {
    mockListDecisions.mockResolvedValue([...REPO_ONLY, { id: '5', title: 'Rotate the client keys', summary: '', platform: 'github', status: 'active', source_url: 'https://github.com/acme/billing-private/pull/3' }]);
    await run();
    expect(gitignore()).toContain('.align/decisions.md');
    expect(logs.join('\n')).toMatch(/Kept out of git/);
  });

  it('a doc that is not committed (untracked or ignored) keeps the file out of git', async () => {
    fs.writeFileSync(path.join(repo, 'NOTES.md'), '# private\n');
    mockListDecisions.mockResolvedValue([...REPO_ONLY, { id: '6', title: 'Private notes', summary: '', platform: 'docs', status: 'active', source_url: 'https://github.com/acme/api/blob/main/NOTES.md#private' }]);
    await run();
    expect(gitignore()).toContain('.align/decisions.md');
    expect(logs.join('\n')).toMatch(/Kept out of git/);
  });

  it('writes a real file, adds nothing to .gitignore, and says it can be committed', async () => {
    mockListDecisions.mockResolvedValue(REPO_ONLY);
    await run();
    const file = path.join(repo, '.align/decisions.md');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('Retry webhooks with backoff instead of failing the event');
    expect(gitignore()).toBeNull();
    expect(logs.join('\n')).toMatch(/comes from this repo.*commit it/s);
    expect(logs.join('\n')).not.toMatch(/Kept out of git/);
  });

  it('one decision from outside the repo keeps the file out of git', async () => {
    mockListDecisions.mockResolvedValue([...REPO_ONLY, { id: '4', title: 'Freeze deploys on Fridays', summary: '', platform: 'slack', status: 'active', source_url: 'https://acme.slack.com/archives/C1/p1' }]);
    await run();
    expect(gitignore()).toContain('.align/decisions.md');
    expect(logs.join('\n')).toMatch(/Kept out of git/);
  });

  it.skipIf(process.platform === 'win32')('a file that was kept out of git before becomes a real file, and the line Align added to .gitignore goes', async () => {
    mockListDecisions.mockResolvedValue([{ id: '9', title: 'From chat', summary: '', platform: 'slack', status: 'active', source_url: 'https://acme.slack.com/archives/C1/p2' }]);
    await run();
    const file = path.join(repo, '.align/decisions.md');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    const external = fs.realpathSync(file);
    fs.writeFileSync(path.join(repo, '.gitignore'), `dist\n${fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')}`);
    mockListDecisions.mockResolvedValue(REPO_ONLY);
    await run();
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('Use Postgres 16');
    expect(fs.readFileSync(external, 'utf8')).toContain('From chat'); // the private copy is never written through
    expect(gitignore()).toBe('dist\n');
  });

  it('removes a leading-slash ignore line too, so the file it says to commit is not ignored', async () => {
    mockListDecisions.mockResolvedValue(REPO_ONLY);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n/.align/decisions.md\n');
    await run();
    expect(gitignore()).not.toContain('.align/decisions.md');
    expect(logs.join('\n')).toMatch(/normal file: commit it/);
  });

  it('warns instead of saying "commit it" when a broader rule still ignores the file, and leaves that rule alone', async () => {
    mockListDecisions.mockResolvedValue(REPO_ONLY);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.align/\n');
    await run();
    expect(gitignore()).toBe('.align/\n');
    expect(logs.join('\n')).not.toMatch(/normal file: commit it/);
    expect(logs.join('\n')).toMatch(/still ignored by git.*"\.align\/"/s);
  });
});

describe('align context sync, team graph', () => {
  it('leaves .gitignore alone and says nothing about git (two examples: no file, an existing file)', async () => {
    state.mode = 'cloud';
    await run();
    expect(gitignore()).toBeNull();
    expect(logs.join('\n')).not.toMatch(/Kept out of git/);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'dist\n');
    await run();
    expect(gitignore()).toBe('dist\n');
  });

  it('writes a REAL file, never a symlink - team content is meant to be shared/committed', async () => {
    state.mode = 'cloud';
    await run();
    expect(fs.lstatSync(path.join(repo, '.align/decisions.md')).isSymbolicLink()).toBe(false);
  });
});
