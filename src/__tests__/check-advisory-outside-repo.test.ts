import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const startCwd = process.cwd();

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'align-outside-')));
  repo = path.join(root, 'repo');
  other = path.join(root, 'other');
  scratch = path.join(root, 'scratch');
  for (const d of [repo, other, scratch, path.join(repo, 'src')]) mkdirSync(d, { recursive: true });
  git(repo, 'init', '-q');
  git(other, 'init', '-q');
  writeFileSync(path.join(repo, 'README.md'), 'hello\n');
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
});
