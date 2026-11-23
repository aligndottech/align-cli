/**
 * `align check` with a secret in the staged diff: real git, a stub judge that says "aligned" (what the judge said
 * for Chirag Mangal's staged ghp_ token, because the rule against secrets never reached it through retrieval).
 * Fixtures that look like credentials are built at runtime, never written as literals.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: null, tenantId: null, mode: 'auth', localDbPath: '' })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'local') }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })) }));

const ALIGNED = { status: 'aligned', confidence: 0.9, relevant_decisions: [], conflicts: [], message: 'ok' };
const GH_TOKEN = `ghp_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3kLn'.slice(0, 36)}`;
const FINGERPRINT = 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';
let repo: string;
let cwd0: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};

async function runCheck(args: string[]): Promise<{ exitCode: number | undefined; json: any; log: string; raw: string }> {
  const program = new Command();
  registerCheckCommand(program);
  let exitCode: number | undefined;
  let out = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { if (exitCode === undefined) exitCode = c; throw new Error('__exit__'); }) as never);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  let log = '';
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { log += `${a.join(' ')}\n`; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { await program.parseAsync(['node', 'align', 'check', ...args]); } catch { /* exit spy */ }
  finally { exitSpy.mockRestore(); writeSpy.mockRestore(); errSpy.mockRestore(); logSpy.mockRestore(); }
  const line = out.trim().split('\n').filter(Boolean)[0];
  return { exitCode, json: line ? JSON.parse(line) : undefined, log, raw: out + log };
}

beforeEach(() => {
  vi.clearAllMocks();
  cwd0 = process.cwd();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'align-secret-precheck-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.test'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  write('README.md', 'hello\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  process.chdir(repo);
  mockCheckAlignment.mockResolvedValue(ALIGNED);
});
afterEach(() => {
  process.chdir(cwd0);
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('align check: secret shapes in the staged diff', () => {
  it('a staged file holding a GitHub token is a critical finding naming file and line, even though the judge said aligned', async () => {
    write('deploy/.env', `# deploy\nAPP=x\nGITHUB_TOKEN=${GH_TOKEN}\n`);
    git('add', '.');
    const { exitCode, json, raw } = await runCheck(['--ci']);
    expect(exitCode).toBe(1);
    expect(json.status).toBe('conflicting');
    expect(json.conflicts).toHaveLength(1);
    expect(json.conflicts[0].severity).toBe('critical');
    expect(json.conflicts[0].reason).toContain('deploy/.env');
    expect(json.conflicts[0].reason).toContain('line 3');
    expect(json.conflicts[0].reason).toContain('GitHub token');
    expect(raw).not.toContain(GH_TOKEN);
  });

  it('still flags when the judge throws: the pre-check needs no model', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('provider down'));
    write('a.env', `T=${GH_TOKEN}\n`);
    git('add', '.');
    const { exitCode, json } = await runCheck(['--ci']);
    expect(exitCode).toBe(1);
    expect(json.conflicts[0].severity).toBe('critical');
  });

  it('keeps the judge conflicts and adds the secret finding first', async () => {
    mockCheckAlignment.mockResolvedValue({ ...ALIGNED, status: 'conflicting', conflicts: [{ decision_id: 'd1', title: 'Use Postgres', reason: 'r', severity: 'warning' }] });
    write('a.env', `T=${GH_TOKEN}\n`);
    git('add', '.');
    const { json } = await runCheck(['--ci']);
    expect(json.conflicts.map((c: { title: string }) => c.title)[1]).toBe('Use Postgres');
    expect(json.conflicts[0].severity).toBe('critical');
  });

  it('a private key header, an AWS access key id and a Slack token are caught too', async () => {
    write('k.pem', `-----BEGIN ${'RSA '}PRIVATE KEY-----\nMIIB\n`);
    write('aws.txt', `id = AKIA${'ABCDEFGHIJKLMNOP'}\n`);
    write('s.txt', `x = ${'xox'}b-${'1234567890'}-${'1234567890123'}-${'abcdefghijklmnopqrstuvwx'}\n`);
    git('add', '.');
    const { json } = await runCheck(['--ci']);
    expect(json.conflicts).toHaveLength(3);
    const reasons = json.conflicts.map((c: { reason: string }) => c.reason).join('\n');
    expect(reasons).toContain('private key');
    expect(reasons).toContain('AWS access key');
    expect(reasons).toContain('Slack token');
  });

  it('a harmless README edit is whatever the judge said', async () => {
    write('README.md', 'hello world\nSee docs for the GITHUB_TOKEN variable name.\n');
    git('add', '.');
    const { exitCode, json } = await runCheck(['--ci']);
    expect(exitCode).toBe(0);
    expect(json).toEqual(ALIGNED);
  });

  it('a public SSH fingerprint is not a secret', async () => {
    write('README.md', `Signed with ${FINGERPRINT}\n`);
    git('add', '.');
    const { exitCode, json } = await runCheck(['--ci']);
    expect(exitCode).toBe(0);
    expect(json).toEqual(ALIGNED);
  });

  it('a token that was only REMOVED by the change is not reported', async () => {
    write('old.env', `T=${GH_TOKEN}\n`);
    git('add', '.'); git('commit', '-q', '-m', 'oops');
    git('rm', '-q', 'old.env');
    const { exitCode } = await runCheck(['--ci']);
    expect(exitCode).toBe(0);
  });

  it('the human path prints a CRITICAL badge and exits 1', async () => {
    write('a.env', `T=${GH_TOKEN}\n`);
    git('add', '.');
    const { exitCode, log } = await runCheck([]);
    expect(exitCode).toBe(1);
    expect(log).toContain('CRITICAL');
    expect(log).toContain('a.env');
    expect(log).not.toContain(GH_TOKEN);
  });
});
