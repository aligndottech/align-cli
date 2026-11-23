import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerCheckCommand } from '../commands/check.js';

/**
 * The pre-edit hook checks the file an edit writes against the repository the hook runs in. Coding agents
 * also write files that are not part of it - a scratch note, a plan in /tmp, a file in a sibling checkout -
 * and those used to get this repository's decisions too, on every write.
 *
 * Test list:
 * 1. a file in no repository: nothing is retrieved and nothing is printed
 * 2. a file in another repository: the same
 * 3. control: a new file in this repository is checked and its decisions are printed
 * 4. control: from a subfolder, a file elsewhere in the same repository (../) is still checked
 * 5. control: a relative path under the working folder is checked without asking git
 * 6. a file outside the repository that links into it: it is checked (needs file symlinks, which Windows may refuse)
 * 7. a folder inside the repository that links out of it: a file written through it is not
 * 8. the same, for a file that does not exist yet
 * 9. a linked worktree is the same repository: a new file in it is checked from the main checkout
 * 10. the same from the worktree, for a file in the main checkout; a file in another repository still is not
 */
const mockCheckAlignment = vi.fn();
const mockPayload = vi.fn();
vi.mock('../lib/hook-payload.js', () => ({ readHookPayload: () => Promise.resolve(mockPayload()) }));
vi.mock('../lib/setup-state.js', () => ({ isAlignSetUp: () => true }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded' })) })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local') }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })) }));
vi.mock('../lib/agent-use-telemetry.js', () => ({ recordAgentUse: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/advisory-dedup.js', () => ({ dedupScope: (cwd: string) => cwd, recentlySurfaced: () => new Set<string>(), markSurfaced: vi.fn() }));

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

let root: string;
let repo: string;
let other: string;
let scratch: string;
let worktree: string;
let fileLinks = true;
const startCwd = process.cwd();

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'align-outside-')));
  repo = path.join(root, 'repo');
  other = path.join(root, 'other');
  scratch = path.join(root, 'scratch');
  worktree = path.join(root, 'worktree');
  for (const d of [repo, other, scratch, path.join(repo, 'src')]) mkdirSync(d, { recursive: true });
  symlinkSync(path.join(repo, 'src'), path.join(scratch, 'into-repo'), 'junction');
  symlinkSync(scratch, path.join(repo, 'out-of-repo'), 'junction');
  git(repo, 'init', '-q');
  git(other, 'init', '-q');
  writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  writeFileSync(path.join(repo, 'src', 'existing.ts'), 'export {};\n');
  writeFileSync(path.join(scratch, 'notes.md'), 'notes\n');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e.co', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'linked');
  try {
    symlinkSync(path.join(repo, 'src', 'existing.ts'), path.join(scratch, 'existing-link.ts'), 'file');
  } catch {
    fileLinks = false;
  }
});

afterAll(() => {
  process.chdir(startCwd);
  rmSync(root, { recursive: true, force: true });
});

async function preEdit(cwd: string, filePath: string): Promise<string> {
  mockPayload.mockReturnValue({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath, content: 'Store sessions in Postgres.' }, cwd });
  const program = new Command();
  registerCheckCommand(program);
  let stdout = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => { throw new Error(`exit(${code})`); });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'align', 'check', '--advisory', '--format', 'pi']);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return stdout;
}

describe('the pre-edit hook only checks files in the repository it runs in', () => {
  beforeEach(() => {
    mockCheckAlignment.mockReset();
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [{ id: 'd1', title: 'Chose Postgres for sessions' }] });
  });

  it('does not check a file in no repository', async () => {
    const out = await preEdit(repo, path.join(scratch, 'notes.md'));
    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(out).toBe('');
  });

  it('does not check a file in another repository', async () => {
    const out = await preEdit(repo, path.join(other, 'plan.md'));
    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(out).toBe('');
  });

  it('checks a new file in this repository', async () => {
    const out = await preEdit(repo, path.join(repo, 'src', 'sessions.ts'));
    expect(mockCheckAlignment).toHaveBeenCalled();
    expect(out).toContain('Chose Postgres for sessions');
  });

  it('checks a file elsewhere in the same repository from a subfolder', async () => {
    const out = await preEdit(path.join(repo, 'src'), '../README.md');
    expect(mockCheckAlignment).toHaveBeenCalled();
    expect(out).toContain('Chose Postgres for sessions');
  });

  it('checks a relative path under the working folder', async () => {
    const out = await preEdit(repo, 'src/new-dir/sessions.ts');
    expect(mockCheckAlignment).toHaveBeenCalled();
    expect(out).toContain('Chose Postgres for sessions');
  });

  it('checks a file in this repository written through a link that sits outside it', async ({ skip }) => {
    if (!fileLinks) skip();
    const out = await preEdit(repo, path.join(scratch, 'existing-link.ts'));
    expect(mockCheckAlignment).toHaveBeenCalled();
    expect(out).toContain('Chose Postgres for sessions');
  });

  it('does not check a file outside this repository written through a link that sits inside it', async () => {
    const out = await preEdit(repo, 'out-of-repo/notes.md');
    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(out).toBe('');
  });

  it('follows links for a file that does not exist yet', async () => {
    expect(await preEdit(repo, 'out-of-repo/new/plan.md')).toBe('');
    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(await preEdit(repo, path.join(scratch, 'into-repo', 'new', 'sessions.ts'))).toContain('Chose Postgres for sessions');
    expect(mockCheckAlignment).toHaveBeenCalled();
  });

  it('checks a new file in a linked worktree of this repository', async () => {
    const out = await preEdit(repo, path.join(worktree, 'src', 'sessions.ts'));
    expect(mockCheckAlignment).toHaveBeenCalled();
    expect(out).toContain('Chose Postgres for sessions');
  });

  it('checks a file in the main checkout from a linked worktree, and not one in another repository', async () => {
    expect(await preEdit(worktree, path.join(other, 'plan.md'))).toBe('');
    expect(mockCheckAlignment).not.toHaveBeenCalled();
    expect(await preEdit(worktree, path.join(repo, 'README.md'))).toContain('Chose Postgres for sessions');
    expect(mockCheckAlignment).toHaveBeenCalled();
  });
});
