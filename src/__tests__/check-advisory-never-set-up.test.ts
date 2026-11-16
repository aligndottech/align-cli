import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildProgram } from '../cli.js';
import { createConfigStore } from '../lib/config.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { resolveMcpEnvironment } from '../lib/mcp-env.js';
import { isAlignSetUp } from '../lib/setup-state.js';

// The plugin hook runs `check --advisory` for people who never set Align up. That run must be
// silent and write nothing; a run in a configured project that cannot check must still say so.
vi.mock('../lib/hook-payload.js', () => ({
  readHookPayload: () => Promise.resolve({ hook_event_name: 'PreToolUse', tool_input: { file_path: 'db.ts', content: '// use mongodb\n' } }),
}));

function listing(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: false }).map(String).sort();
}

async function runAdvisory(): Promise<{ exitCode: number | undefined; stdout: string }> {
  // The real command tree, the same one bin uses, so the root preAction hooks run too.
  const program: Command = buildProgram();
  let exitCode: number | undefined;
  let stdout = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit(${code})`);
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'align', 'check', '--advisory']);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return { exitCode: exitCode ?? 0, stdout };
}

describe('check --advisory when Align was never set up', () => {
  let home: string;
  let repo: string;
  const saved = { cwd: process.cwd(), HOME: process.env['HOME'], PROFILE: process.env['USERPROFILE'], XDG: process.env['XDG_CONFIG_HOME'], ENV: process.env['ALIGN_ENV'] };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'align-home-'));
    repo = mkdtempSync(path.join(tmpdir(), 'align-repo-'));
    writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home; // os.homedir() reads this on Windows
    process.env['XDG_CONFIG_HOME'] = path.join(home, '.config');
    delete process.env['ALIGN_ENV'];
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(saved.cwd);
    process.env['HOME'] = saved.HOME;
    if (saved.PROFILE === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = saved.PROFILE;
    if (saved.XDG === undefined) delete process.env['XDG_CONFIG_HOME']; else process.env['XDG_CONFIG_HOME'] = saved.XDG;
    if (saved.ENV !== undefined) process.env['ALIGN_ENV'] = saved.ENV;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('prints nothing, exits 0 and writes nothing in the project or the home folder', async () => {
    const repoBefore = listing(repo);
    const homeBefore = listing(home);
    expect(repoBefore).toEqual(['README.md']); // non-empty fixture, so equality below is not vacuous

    const { exitCode, stdout } = await runAdvisory();

    expect(stdout).toBe('');
    expect(exitCode).toBe(0);
    expect(listing(repo)).toEqual(repoBefore);
    expect(listing(home)).toEqual(homeBefore);
  });

  it('still prints UNVERIFIED when Align is configured but the gateway is unreachable', async () => {
    mkdirSync(path.join(home, '.align'), { recursive: true });
    writeFileSync(
      path.join(home, '.align', 'config.json'),
      JSON.stringify({ defaultEnv: 'prod', environments: { prod: { gatewayUrl: 'http://127.0.0.1:1', authToken: 'tok', tenantId: 't', mode: 'auth' } } }),
    );

    const { exitCode, stdout } = await runAdvisory();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('UNVERIFIED');
  });

  it('does not count a local graph the MCP server created on a fresh machine as set up', async () => {
    // What `align mcp` does on a fresh machine: open the config store, serve a local graph at the setup path.
    const { env } = resolveMcpEnvironment(undefined, createConfigStore(), path.join(home, '.align', 'local.db'));
    createLocalGatewayClient(env.localDbPath ?? ':memory:');
    expect(readdirSync(path.join(home, '.align'))).toContain('config.json');

    expect(isAlignSetUp(repo)).toBe(false);
  });

  it('counts a saved login, a saved local environment and a project .align as set up', () => {
    mkdirSync(path.join(home, '.align'), { recursive: true });
    const cfg = path.join(home, '.align', 'config.json');
    writeFileSync(cfg, JSON.stringify({ environments: { prod: { authToken: 'tok' } } }));
    expect(isAlignSetUp(repo)).toBe(true);
    writeFileSync(cfg, JSON.stringify({ environments: { local: { mode: 'local-embedded' } } }));
    expect(isAlignSetUp(repo)).toBe(true);
    writeFileSync(cfg, JSON.stringify({ environments: {}, defaultEnv: 'prod' }));
    expect(isAlignSetUp(repo)).toBe(false);
    mkdirSync(path.join(repo, '.align'));
    expect(isAlignSetUp(repo)).toBe(true);
  });
});
