/**
 * `align check` with a co-change rule in the local graph: real git, a real local graph, a stub judge.
 *
 * The rule is "a change touching openapi/** must also touch docs/changelog.md" (Recart's README rule).
 * Each scenario runs the whole command, because the bugs worth catching are in the joins: the file
 * list the rule sees, what the judge said (or failed to say), the exit code and the JSON a CI step reads.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import { addCoChangeRule } from '../lib/co-change-store.js';

const mockCheckAlignment = vi.fn();
let envMode: 'local-embedded' | 'auth' = 'local-embedded';
let dbPath = '';

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: null, tenantId: null, mode: envMode, localDbPath: dbPath })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local') }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })) }));

const ALIGNED = { status: 'aligned', confidence: 0.9, relevant_decisions: [], conflicts: [], message: 'ok' };
let repo: string;
let cwd0: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
const commit = (files: Record<string, string>, msg: string) => {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  git('add', '.'); git('commit', '-q', '-m', msg);
};

async function runCheck(args: string[]): Promise<{ exitCode: number | undefined; json: any }> {
  const program = new Command();
  registerCheckCommand(program);
  let exitCode: number | undefined;
  let out = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { if (exitCode === undefined) exitCode = c; throw new Error('__exit__'); }) as never);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { await program.parseAsync(['node', 'align', 'check', ...args]); } catch { /* exit spy */ }
  finally { exitSpy.mockRestore(); writeSpy.mockRestore(); errSpy.mockRestore(); }
  const line = out.trim().split('\n').filter(Boolean)[0];
  return { exitCode, json: line ? JSON.parse(line) : undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMode = 'local-embedded';
  cwd0 = process.cwd();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cochange-cmd-'));
  dbPath = path.join(repo, '..', `${path.basename(repo)}.db`);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.test'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  commit({ 'README.md': 'x\n', 'docs/changelog.md': 'v1\n', 'openapi/2023-12.yaml': 'a: 1\n' }, 'base');
  git('checkout', '-q', '-b', 'pr');
  process.chdir(repo);
  mockCheckAlignment.mockResolvedValue(ALIGNED);
  addCoChangeRule(dbPath, { title: 'Every notable API change adds a changelog entry', summary: 'README: docs/changelog.md in the same PR', rule: { when_paths: ['openapi/**'], require_paths: ['docs/changelog.md'], scope: 'same_pr' } });
});
afterEach(() => {
  process.chdir(cwd0);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dbPath, { force: true });
});

describe('align check: co-change rules', () => {
  it('a PR that touches openapi/** and not the changelog is a conflict citing the rule, even though the judge said aligned', async () => {
    commit({ 'openapi/2023-12.yaml': 'a: 2\n' }, 'change spec');
    const { exitCode, json } = await runCheck(['--ci', '--base', 'main']);
    expect(exitCode).toBe(1);
    expect(json.status).toBe('conflicting');
    expect(json.conflicts).toHaveLength(1);
    expect(json.conflicts[0].title).toBe('Every notable API change adds a changelog entry');
    expect(json.conflicts[0].reason).toContain('openapi/2023-12.yaml');
    expect(json.conflicts[0].reason).toContain('docs/changelog.md');
  });

  it('the same PR with the changelog entry is whatever the judge said', async () => {
    commit({ 'openapi/2023-12.yaml': 'a: 2\n', 'docs/changelog.md': 'v2\n' }, 'change spec + changelog');
    const { exitCode, json } = await runCheck(['--ci', '--base', 'main']);
    expect(exitCode).toBe(0);
    expect(json, JSON.stringify(json)).toEqual(ALIGNED);
  });

  it('the changelog landing in a LATER commit of the same PR counts (the rule is per PR, not per commit)', async () => {
    commit({ 'openapi/2023-12.yaml': 'a: 2\n' }, 'spec');
    commit({ 'docs/changelog.md': 'v2\n' }, 'changelog');
    expect((await runCheck(['--ci', '--base', 'main'])).exitCode).toBe(0);
  });

  it('a PR that touches no openapi/** file adds nothing', async () => {
    commit({ 'README.md': 'y\n' }, 'readme');
    const { exitCode, json } = await runCheck(['--ci', '--base', 'main']);
    expect(exitCode).toBe(0);
    expect(json, JSON.stringify(json)).toEqual(ALIGNED);
  });

  it('still flags when the judge throws: the rule needs no model', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('provider down'));
    commit({ 'openapi/2023-12.yaml': 'a: 2\n' }, 'spec');
    const { exitCode, json } = await runCheck(['--ci', '--base', 'main']);
    expect(exitCode).toBe(1);
    expect(json.status).toBe('conflicting');
    expect(json.conflicts[0].title).toBe('Every notable API change adds a changelog entry');
  });

  it('still flags when the judge answers unknown (unparseable)', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'unknown', reason: 'classifier_unparseable', confidence: 0, relevant_decisions: [], conflicts: [], message: 'Could not check' });
    commit({ 'openapi/2023-12.yaml': 'a: 2\n' }, 'spec');
    const { exitCode, json } = await runCheck(['--ci', '--base', 'main']);
    expect(exitCode).toBe(1);
    expect(json.status).toBe('conflicting');
  });

  it('with the judge down and nothing violated, the outage is still an error (exit 2), not a pass', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('provider down'));
    commit({ 'README.md': 'y\n' }, 'readme');
    const { exitCode, json } = await runCheck(['--ci', '--base', 'main']);
    expect(exitCode).toBe(2);
    expect(json.status).toBe('error');
  });

  it('every run flags again: no dedup window swallows a violation', async () => {
    commit({ 'openapi/2023-12.yaml': 'a: 2\n' }, 'spec');
    expect((await runCheck(['--ci', '--base', 'main'])).exitCode).toBe(1);
    expect((await runCheck(['--ci', '--base', 'main'])).exitCode).toBe(1);
  });

  it('an unresolvable base is still exit 2, never a silent pass of the rule', async () => {
    const { exitCode, json } = await runCheck(['--ci', '--base', 'no-such-ref']);
    expect(exitCode).toBe(2);
    expect(json.reason).toBe('bad_base_ref');
  });

  it('rules are a local-graph feature: against a cloud environment the local graph is not read', async () => {
    envMode = 'auth';
    commit({ 'openapi/2023-12.yaml': 'a: 2\n' }, 'spec');
    const { exitCode, json } = await runCheck(['--ci', '--base', 'main']);
    expect(exitCode).toBe(0);
    expect(json, JSON.stringify(json)).toEqual(ALIGNED);
  });

  it('the pre-commit hook does not evaluate a PR-scoped rule against one commit', async () => {
    fs.writeFileSync(path.join(repo, 'openapi/2023-12.yaml'), 'a: 3\n');
    git('add', '.');
    const { exitCode } = await runCheck(['--hook']);
    expect(exitCode).not.toBe(1);
  });

  it('a staged-only check (no --base) sees the staged files', async () => {
    fs.writeFileSync(path.join(repo, 'openapi/2023-12.yaml'), 'a: 3\n');
    git('add', '.');
    const { exitCode, json } = await runCheck(['--ci']);
    expect(exitCode).toBe(1);
    expect(json.conflicts[0].reason).toContain('openapi/2023-12.yaml');
  });
});
