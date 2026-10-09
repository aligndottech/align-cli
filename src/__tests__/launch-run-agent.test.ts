import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent, type RunDeps } from '../lib/launch/run-agent.js';
import type { LaunchSpec } from '../lib/launch/adapters/claude-code.js';

const spec: LaunchSpec = { bin: 'claude', args: ['--resume', 'abc'], env: { ALIGN_WRAPPED: '1' }, files: [] };

class FakeChild extends EventEmitter { kill = vi.fn(); }
function fake(finish: (child: FakeChild) => void) {
  const child = new FakeChild();
  const spawn = vi.fn(() => { setImmediate(() => finish(child)); return child; });
  return { child, spawn: spawn as unknown as RunDeps['spawn'], spawnMock: spawn };
}
const exiting = (code: number) => fake((c) => c.emit('exit', code, null));
const deps = (over: Partial<RunDeps>): Partial<RunDeps> => ({ proc: new EventEmitter() as unknown as RunDeps['proc'], platform: 'linux', ...over });

describe('runAgent exit codes', () => {
  it.each([[0, 0], [3, 3]])('exits with the child code (%i -> %i)', async (childCode, expected) => {
    expect(await runAgent(spec, deps({ spawn: exiting(childCode).spawn }))).toBe(expected);
  });
  it('maps a SIGTERM death to 143 and a SIGINT death to 130', async () => {
    expect(await runAgent(spec, deps({ spawn: fake((c) => c.emit('exit', null, 'SIGTERM')).spawn }))).toBe(143);
    expect(await runAgent(spec, deps({ spawn: fake((c) => c.emit('exit', null, 'SIGINT')).spawn }))).toBe(130);
  });
  it('rejects when the binary cannot be started (ENOENT surfaces to the caller)', async () => {
    const f = fake((c) => c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    await expect(runAgent(spec, deps({ spawn: f.spawn }))).rejects.toThrow(/ENOENT/);
  });
});

describe('runAgent spawn options', () => {
  it('inherits stdio and adds the spec env on top of the parent env', async () => {
    const f = exiting(0);
    await runAgent(spec, deps({ spawn: f.spawn }));
    const [cmd, args, opts] = f.spawnMock.mock.calls[0] as unknown as [string, string[], { stdio: string; env: Record<string, string> }];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['--resume', 'abc']);
    expect(opts.stdio).toBe('inherit');
    expect(opts.env.ALIGN_WRAPPED).toBe('1');
    expect(opts.env.PATH).toBe(process.env.PATH);
  });
});

describe('runAgent signals', () => {
  it.each(['SIGTERM', 'SIGHUP', 'SIGQUIT'] as const)('forwards %s to the child and waits for it', async (sig) => {
    const proc = new EventEmitter();
    let settled = false;
    const f = fake(() => { /* the child never exits by itself */ });
    const p = runAgent(spec, deps({ spawn: f.spawn, proc: proc as unknown as RunDeps['proc'] })).then((c) => { settled = true; return c; });
    await new Promise((r) => setImmediate(r));
    proc.emit(sig);
    expect(f.child.kill).toHaveBeenCalledWith(sig);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    f.child.emit('exit', null, sig);
    expect(await p).toBe({ SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 }[sig]);
  });
  it('does not exit before the child on SIGINT, and does not signal it twice', async () => {
    const proc = new EventEmitter();
    let settled = false;
    const f = fake(() => {});
    const p = runAgent(spec, deps({ spawn: f.spawn, proc: proc as unknown as RunDeps['proc'] })).then((c) => { settled = true; return c; });
    await new Promise((r) => setImmediate(r));
    expect(proc.listenerCount('SIGINT')).toBe(1);
    proc.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(f.child.kill).not.toHaveBeenCalled();
    f.child.emit('exit', 0, null);
    expect(await p).toBe(0);
  });
  it('removes its signal listeners once the child is gone', async () => {
    const proc = new EventEmitter();
    await runAgent(spec, deps({ spawn: exiting(0).spawn, proc: proc as unknown as RunDeps['proc'] }));
    for (const s of ['SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGINT']) expect(proc.listenerCount(s)).toBe(0);
  });
});

describe('runAgent on win32', () => {
  it('runs a .cmd shim through cmd.exe /d /s /c with quoted args', async () => {
    const f = exiting(0);
    await runAgent({ ...spec, bin: 'C:\\npm\\claude.cmd', args: ['--resume', 'a b'] }, deps({ platform: 'win32', spawn: f.spawn }));
    const [cmd, args, opts] = f.spawnMock.mock.calls[0] as unknown as [string, string[], { windowsVerbatimArguments?: boolean }];
    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toBe('""C:\\npm\\claude.cmd" "--resume" "a b""');
    expect(opts.windowsVerbatimArguments).toBe(true);
  });
  it('doubles trailing backslashes before the closing quote (CRT argv rules)', async () => {
    const f = exiting(0);
    await runAgent({ ...spec, bin: 'C:\\npm\\claude.cmd', args: ['C:\\proj\\', 'C:\\a b\\\\', 'mid\\dle'] }, deps({ platform: 'win32', spawn: f.spawn }));
    const line = (f.spawnMock.mock.calls[0] as unknown as [string, string[]])[1][3]!;
    expect(line).toBe('""C:\\npm\\claude.cmd" "C:\\proj\\\\" "C:\\a b\\\\\\\\" "mid\\dle""');
  });
  it('refuses a bin path that itself holds a shell character, saying so', async () => {
    const f = exiting(0);
    await expect(runAgent({ ...spec, bin: 'C:\\Users\\a&b\\claude.cmd' }, deps({ platform: 'win32', spawn: f.spawn }))).rejects.toThrow(/path to claude.*shell character &/s);
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it('names the argument, its position and the pass-through limit on Windows', async () => {
    const f = exiting(0);
    await expect(runAgent({ ...spec, bin: 'C:\\npm\\claude.cmd', args: ['ok', '50%'] }, deps({ platform: 'win32', spawn: f.spawn }))).rejects.toThrow(/argument 2 \("50%"\).*%.*passing arguments after `align --` has this limit on Windows/is);
  });
  it.each(['a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a"b'])('refuses a pass-through arg %s and spawns nothing', async (bad) => {
    const f = exiting(0);
    await expect(runAgent({ ...spec, bin: 'C:\\npm\\claude.cmd', args: [bad] }, deps({ platform: 'win32', spawn: f.spawn }))).rejects.toThrow(/shell character/);
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it('does not apply the metacharacter refusal to a real .exe or off win32', async () => {
    const f = exiting(0);
    await runAgent({ ...spec, args: ['a&b'] }, deps({ platform: 'linux', spawn: f.spawn }));
    expect(f.spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('runAgent with a real fake binary on disk', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it.skipIf(process.platform === 'win32')('records its argv and env, and align returns its exit code', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'align-fakebin-'));
    const bin = path.join(dir, 'claude');
    const out = path.join(dir, 'argv.txt');
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\necho "WRAPPED=$ALIGN_WRAPPED" >> "${out}"\nexit 7\n`);
    chmodSync(bin, 0o755);
    const code = await runAgent({ ...spec, bin }, { proc: new EventEmitter() as unknown as RunDeps['proc'] });
    expect(code).toBe(7);
    expect(readFileSync(out, 'utf8')).toBe('--resume\nabc\nWRAPPED=1\n');
  });
});

/**
 * H1: a provider key align put into process.env must never reach the agent. A saved
 * ANTHROPIC_API_KEY inherited by Claude Code switches a Max subscription to API billing;
 * OPENAI_API_KEY does the same to Codex, GEMINI_API_KEY to Gemini CLI. The rule is
 * restore-to-startup: every provider variable goes to the child exactly as the user's shell
 * had it when align started - a key the user exported is kept, one align added is dropped.
 */
describe('runAgent never hands the agent a provider key align added', () => {
  const childEnv = async (parentEnv: Record<string, string>, startupEnv: Record<string, string>) => {
    const f = exiting(0);
    const saved = { ...process.env };
    try {
      for (const [k, v] of Object.entries(parentEnv)) process.env[k] = v;
      await runAgent(spec, deps({ spawn: f.spawn, startupEnv }));
    } finally {
      for (const k of Object.keys(parentEnv)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    return (f.spawnMock.mock.calls[0] as unknown as [string, string[], { env: Record<string, string | undefined> }])[2].env;
  };

  it.each([
    ['ANTHROPIC_API_KEY', 'Claude Code'],
    ['OPENAI_API_KEY', 'Codex'],
    ['GEMINI_API_KEY', 'Gemini CLI'],
  ])('drops %s when align added it (it would reach %s)', async (name) => {
    const env = await childEnv({ [name]: 'saved-by-align' }, {});
    expect(env[name]).toBeUndefined();
  });

  it.each(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'])('keeps %s the user exported', async (name) => {
    const env = await childEnv({ [name]: 'users-own' }, { [name]: 'users-own' });
    expect(env[name]).toBe('users-own');
  });

  it('restores the user\'s own value when align overwrote it', async () => {
    const env = await childEnv({ OPENAI_API_KEY: 'align-wrote-this' }, { OPENAI_API_KEY: 'users-own' });
    expect(env.OPENAI_API_KEY).toBe('users-own');
  });

  it('drops align-added endpoint and preference variables too, and leaves unrelated ones alone', async () => {
    const env = await childEnv(
      { ALIGN_LLM_BASE_URL: 'https://openrouter.ai/api/v1', ALIGN_LLM_PROVIDER: 'groq', SOME_OTHER_VAR: 'x' },
      {},
    );
    expect(env.ALIGN_LLM_BASE_URL).toBeUndefined();
    expect(env.ALIGN_LLM_PROVIDER).toBeUndefined();
    expect(env.SOME_OTHER_VAR).toBe('x');
    expect(env.ALIGN_WRAPPED).toBe('1'); // the spec's own env still lands on top
  });
});
