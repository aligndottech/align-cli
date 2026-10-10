import { describe, expect, it, vi } from 'vitest';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import { alignEntryShape } from './helpers/platform.js';

const CLAUDE = '/usr/bin/claude';
function harness(over: Partial<LaunchDeps> & { stored?: string; onPath?: Record<string, string> } = {}) {
  let stored = over.stored;
  const onPath = over.onPath ?? { claude: CLAUDE };
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const written: Array<[string, string]> = [];
  const runAgent = vi.fn().mockResolvedValue(0);
  const record = vi.fn();
  // Pressing Enter: the preselected row (the one installed agent), else nothing.
  const pick = vi.fn(async (_o: unknown, initial?: string) => initial ?? null);
  const setAgent = vi.fn((a: string) => { stored = a; });
  const deps: LaunchDeps = {
    env: {},
    argv: ['node', 'align'],
    cwd: '/proj',
    home: '/home/u',
    platform: 'linux',
    isTTY: true,
    config: { getAgent: () => stored, setAgent },
    findOnPath: (bin) => onPath[bin] ?? null,
    readProjectState: () => ({ projectHasPreHook: false, projectHasPostHook: false, projectHasMcp: false, projectHasBlock: false }),
    readOpenCodeState: () => ({ projectHasPlugin: false, projectHasMcp: false, projectHasBlock: false }),
    readPiState: () => ({ projectHasExtension: false, projectHasMcp: false, projectHasBlock: false, mcpAdapterInstalled: true, mcpFile: '/home/u/.pi/agent/mcp.json' }),
    readCursorState: () => ({ projectHasMcp: false, mcpFile: '/home/u/.cursor/mcp.json' }),
    readCodexState: () => ({ present: false, overridden: [] }),
    readGeminiState: () => ({ present: false, overridden: [], systemSettings: { path: '/etc/gemini-cli/settings.json', text: null, unreadable: false }, trust: 'untrusted' }),
    readCopilotState: () => ({ present: false, overridden: [] }),
    pruneLaunchFiles: vi.fn(),
    applyConfigWrite: vi.fn(),
    cacheDir: () => '/cache',
    writeIfChanged: (_d, name, content) => { written.push([name, content]); return true; },
    runAgent,
    record,
    pick,
    confirm: vi.fn(async () => false),
    spawnInstall: vi.fn(),
    err: (l) => err.push(l),
    now: () => 42,
    ...over,
  };
  return { deps, out: err, logSpy, err, written, runAgent, record, pick, setAgent, stored: () => stored };
}

describe('launchIfChosen: when it launches', () => {
  it('launches claude with the injected flags when claude-code is chosen and on PATH', async () => {
    const h = harness({ stored: 'claude-code' });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    const spec = h.runAgent.mock.calls[0]![0];
    expect(spec.bin).toBe('/usr/bin/claude');
    expect(spec.args).toEqual(expect.arrayContaining(['--mcp-config', '--settings', '--append-system-prompt-file']));
    expect(spec.args).toContain('/cache/claude-mcp.json');
    expect(h.written.map(([n]) => n).sort()).toEqual(['align-instructions.md', 'claude-mcp.json', 'claude-settings.json']);
    expect(h.pick).not.toHaveBeenCalled();
  });
  it('returns the agent\'s exit code', async () => {
    const h = harness({ stored: 'claude-code' });
    h.runAgent.mockResolvedValue(3);
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 3 });
  });
  it('skips injections the project already carries', async () => {
    const h = harness({ stored: 'claude-code', readProjectState: () => ({ projectHasPreHook: true, projectHasPostHook: true, projectHasMcp: true, projectHasBlock: true }) });
    await launchIfChosen(h.deps);
    expect(h.runAgent.mock.calls[0]![0].args).toEqual([]);
    expect(h.written).toEqual([]);
  });
  it('passes through the args after --, first (claude\'s --mcp-config is variadic)', async () => {
    const h = harness({ stored: 'claude-code', argv: ['node', 'align', '--', '--resume', 'abc'] });
    await launchIfChosen(h.deps);
    expect(h.runAgent.mock.calls[0]![0].args.slice(0, 2)).toEqual(['--resume', 'abc']);
  });
  it('records agent_launched once, with the agent name, without awaiting it', async () => {
    const h = harness({ stored: 'claude-code' });
    h.record.mockReturnValue(new Promise(() => {}));
    await launchIfChosen(h.deps);
    expect(h.record).toHaveBeenCalledExactlyOnceWith('claude-code');
  });
});

describe('launchIfChosen: when it does not', () => {
  it.each([[{ ALIGN_WRAPPED: '1' }], [{ ALIGN_NO_LAUNCH: '1' }]])('hands back to the card under %j', async (env) => {
    const h = harness({ stored: 'claude-code', env });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
  it('treats ALIGN_NO_LAUNCH="" as not set', async () => {
    const h = harness({ stored: 'claude-code', env: { ALIGN_NO_LAUNCH: '' } });
    expect((await launchIfChosen(h.deps)).handled).toBe(true);
  });
  it('exits 2 on a positional arg without --, naming it, and spawns nothing', async () => {
    const h = harness({ stored: 'claude-code', argv: ['node', 'align', 'foo'] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 2 });
    expect(h.err.join('\n')).toContain("unknown command 'foo'");
    expect(h.runAgent).not.toHaveBeenCalled();
  });
  it('a stored agent that is no longer on PATH falls back to the card with one stderr line', async () => {
    const h = harness({ stored: 'claude-code', onPath: {} });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.err).toEqual(['Claude Code is not installed any more. Run `align use` to pick another, or reinstall it.']);
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('explicit `align -- <args>` with the stored agent gone: exit 127 with the message, not a silent card', async () => {
    const h = harness({ stored: 'claude-code', onPath: {}, argv: ['node', 'align', '--', '-p', 'hi'] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 127 });
    expect(h.err).toEqual(['Claude Code is not installed any more. Run `align use` to pick another, or reinstall it.']);
    expect(h.runAgent).not.toHaveBeenCalled();
  });
  it('exits 127 when the OS refuses to start it (ENOENT), and 2 for a refused Windows arg', async () => {
    const h = harness({ stored: 'claude-code' });
    h.runAgent.mockRejectedValue(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 127 });
    const h2 = harness({ stored: 'claude-code' });
    h2.runAgent.mockRejectedValue(new Error('refusing argument "a&b": it holds the shell character &'));
    expect(await launchIfChosen(h2.deps)).toEqual({ handled: true, code: 2 });
    expect(h2.err.join('\n')).toContain('shell character');
  });
});

describe('launchIfChosen: no agent chosen (nobody has to run `align use` first)', () => {
  it('on a TTY with one agent on PATH, still shows the picker with it preselected; Enter stores and launches it', async () => {
    const h = harness({ isTTY: true });
    const r = await launchIfChosen(h.deps);
    expect(r).toEqual({ handled: true, code: 0 });
    expect(h.pick).toHaveBeenCalledTimes(1);
    expect(h.pick.mock.calls[0]![1]).toBe('claude-code');
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(h.stored()).toBe('claude-code');
    expect(h.runAgent).toHaveBeenCalledTimes(1);
  });
  it('the same machine on a TTY with OpenCode as the one agent preselects OpenCode (two examples)', async () => {
    const h = harness({ isTTY: true, onPath: { opencode: '/usr/bin/opencode' } });
    await launchIfChosen(h.deps);
    expect(h.pick.mock.calls[0]![1]).toBe('opencode');
  });
  it('no TTY, explicit `--`, one agent on PATH: auto-picks it with no picker, stores it and says so', async () => {
    const h = harness({ isTTY: false, argv: ['node', 'align', '--', 'x'] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.pick).not.toHaveBeenCalled();
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(h.out.join('\n')).toBe('Opening Claude Code. Switch any time with `align use`.');
  });
  it('no TTY and no explicit --: shows the card, launches nothing, stores nothing (HIGH 1)', async () => {
    const h = harness({ isTTY: false });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.pick).not.toHaveBeenCalled();
  });
  it('no TTY but an explicit `align -- ...`: a deliberate request, so it launches (and never prompts)', async () => {
    const h = harness({ isTTY: false, argv: ['node', 'align', '--', '-p', 'hi'] });
    expect((await launchIfChosen(h.deps)).handled).toBe(true);
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.setAgent).toHaveBeenCalledWith('claude-code');
    expect(h.pick).not.toHaveBeenCalled();
  });
  it('no TTY with a CHOSEN agent and no --: still the card (a pipe or cron is not a session)', async () => {
    const h = harness({ isTTY: false, stored: 'claude-code' });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.runAgent).not.toHaveBeenCalled();
  });
  it('no TTY, explicit `--`, none installed: no picker, lists what works, how to install, names `align agents`, exits non-zero', async () => {
    const h = harness({ onPath: {}, isTTY: false, argv: ['node', 'align', '--', 'x'] });
    const r = await launchIfChosen(h.deps);
    expect(r).toEqual({ handled: true, code: 1 });
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('Claude Code');
    expect(h.err.join('\n')).toContain('npm i -g @anthropic-ai/claude-code');
    expect(h.err.join('\n')).toContain('align agents');
    expect(h.pick).not.toHaveBeenCalled();
  });
  it('a stored value that is not in the closed list is treated as no choice', async () => {
    const h = harness({ stored: 'emacs' });
    await launchIfChosen(h.deps);
    expect(h.setAgent).toHaveBeenCalledWith('claude-code');
  });
});

describe('launchIfChosen: more than one supported agent installed', () => {
  const two = (over: Partial<Parameters<typeof harness>[0]> = {}) =>
    harness({ onPath: { claude: CLAUDE, opencode: '/usr/bin/opencode' }, ...over });
  it('asks once on a TTY, offers both, and stores the answer', async () => {
    const h = two({ isTTY: true });
    h.pick.mockResolvedValue('opencode');
    await launchIfChosen(h.deps);
    expect(h.pick).toHaveBeenCalledTimes(1);
    expect(h.pick.mock.calls[0]![0].filter((o: { hint?: string }) => !o.hint).map((o: { value: string }) => o.value)).toEqual(['claude-code', 'opencode']);
    expect(h.setAgent).toHaveBeenCalledWith('opencode');
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('/usr/bin/opencode');
  });
  it('without a TTY it picks by priority (Claude Code first), says so in one stderr line, and asks nothing', async () => {
    const h = two({ isTTY: false, argv: ['node', 'align', '--', 'x'] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.pick).not.toHaveBeenCalled();
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('/usr/bin/claude');
    expect(h.err).toEqual(['Opening Claude Code: more than one coding agent is installed and there is no terminal to ask. Change it with: align use <agent>']);
  });
});

describe('launchIfChosen: OpenCode (C2)', () => {
  const OC = '/usr/bin/opencode';
  it('auto-picks opencode when it is the only supported agent on PATH', async () => {
    const h = harness({ onPath: { opencode: OC } });
    await launchIfChosen(h.deps);
    expect(h.setAgent).toHaveBeenCalledWith('opencode');
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('/usr/bin/opencode');
  });
  it('spawns opencode with OPENCODE_CONFIG_CONTENT and OPENCODE_CONFIG_DIR in the env, and writes the launch files', async () => {
    const h = harness({ stored: 'opencode', onPath: { opencode: OC } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    const spec = h.runAgent.mock.calls[0]![0];
    expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT).mcp['align-local'].command[0]).toBe(alignEntryShape([]).command);
    expect(spec.env.OPENCODE_CONFIG_DIR).toBe('/cache/opencode-config');
    expect(spec.env.ALIGN_WRAPPED).toBe('1');
    expect(h.written.map(([n]) => n).sort()).toEqual(['align-instructions.md', 'opencode-config/plugins/align.js']);
  });
  it('reads the user\'s own OPENCODE_CONFIG_CONTENT from the launch env and merges it', async () => {
    const h = harness({ stored: 'opencode', onPath: { opencode: OC }, env: { OPENCODE_CONFIG_CONTENT: '{"model":"a/b"}' } });
    await launchIfChosen(h.deps);
    const cfg = JSON.parse(h.runAgent.mock.calls[0]![0].env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.model).toBe('a/b');
    expect(cfg.mcp['align-local']).toBeDefined();
  });
  it('skips each injection the project already carries', async () => {
    const h = harness({ stored: 'opencode', onPath: { opencode: OC }, readOpenCodeState: () => ({ projectHasPlugin: true, projectHasMcp: true, projectHasBlock: true }) });
    await launchIfChosen(h.deps);
    expect(h.runAgent.mock.calls[0]![0].env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(h.written).toEqual([]);
  });
  it('prints one stderr line when the user\'s OPENCODE_CONFIG_CONTENT is unusable, and still launches', async () => {
    const h = harness({ stored: 'opencode', onPath: { opencode: OC }, env: { OPENCODE_CONFIG_CONTENT: '{nope' } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.err.filter((l) => l.includes('OPENCODE_CONFIG_CONTENT'))).toHaveLength(1);
  });
  it('passes args after -- through to opencode, untouched', async () => {
    const h = harness({ stored: 'opencode', onPath: { opencode: OC }, argv: ['node', 'align', '--', 'run', 'hi'] });
    await launchIfChosen(h.deps);
    expect(h.runAgent.mock.calls[0]![0].args).toEqual(['run', 'hi']);
  });
  it('does not consult the Claude project state for opencode (and vice versa)', async () => {
    const claudeState = vi.fn().mockReturnValue({ projectHasPreHook: false, projectHasPostHook: false, projectHasMcp: false, projectHasBlock: false });
    const h = harness({ stored: 'opencode', onPath: { opencode: OC }, readProjectState: claudeState });
    await launchIfChosen(h.deps);
    expect(claudeState).not.toHaveBeenCalled();
  });
  it('ALIGN_WRAPPED stops the recursion for opencode too', async () => {
    const h = harness({ stored: 'opencode', onPath: { opencode: OC }, env: { ALIGN_WRAPPED: '1' } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.runAgent).not.toHaveBeenCalled();
  });
});

describe('launchIfChosen: ALIGN_LAUNCH_TRACE / ALIGN_LAUNCH_DRY_RUN', () => {
  it('prints align-overhead-ms and exits 0 before spawning, and sends no telemetry', async () => {
    const h = harness({ stored: 'claude-code', env: { ALIGN_LAUNCH_TRACE: '1', ALIGN_LAUNCH_DRY_RUN: '1' } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.out).toContain('align-overhead-ms=42');
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
  it('trace alone prints the number and still launches', async () => {
    const h = harness({ stored: 'claude-code', env: { ALIGN_LAUNCH_TRACE: '1' } });
    await launchIfChosen(h.deps);
    expect(h.out).toContain('align-overhead-ms=42');
    expect(h.runAgent).toHaveBeenCalledTimes(1);
  });
  it('dry run without trace stays silent and does not spawn', async () => {
    const h = harness({ stored: 'claude-code', env: { ALIGN_LAUNCH_DRY_RUN: '1' } });
    await launchIfChosen(h.deps);
    expect(h.out).toEqual([]);
    expect(h.runAgent).not.toHaveBeenCalled();
  });
});

describe('launchIfChosen: align\'s own lines go to stderr, never stdout (MEDIUM 3)', () => {
  it.each([
    ['the auto-pick announcement', { isTTY: false, argv: ['node', 'align', '--', 'x'] }],
    ['the trace line', { stored: 'claude-code', env: { ALIGN_LAUNCH_TRACE: '1' } }],
    ['a launch note (Gemini\'s folder-trust line)', { stored: 'gemini-cli', onPath: { gemini: '/usr/bin/gemini' } }],
  ] as const)('%s', async (_label, over) => {
    const h = harness({ ...over });
    await launchIfChosen(h.deps);
    expect(h.err.length).toBeGreaterThan(0);
    expect(h.logSpy).not.toHaveBeenCalled();
  });
});

describe('launchIfChosen: persistence and failure fallbacks', () => {
  it('a dry run does not persist the auto-pick (HIGH 10)', async () => {
    const h = harness({ env: { ALIGN_LAUNCH_DRY_RUN: '1' } });
    await launchIfChosen(h.deps);
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.stored()).toBeUndefined();
  });
  it('a real launch does persist the auto-pick', async () => {
    const h = harness({});
    await launchIfChosen(h.deps);
    expect(h.stored()).toBe('claude-code');
  });
  it('a launch-file write failure falls back to the card with one stderr line, not a throw (9)', async () => {
    const h = harness({ stored: 'claude-code', writeIfChanged: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toMatch(/launch files.*EACCES/);
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.setAgent).not.toHaveBeenCalled();
  });
});

describe('launchIfChosen: written-once agents (C4)', () => {
  const PI = '/usr/bin/pi';
  const CURSOR = '/usr/bin/cursor-agent';

  it('launches pi with -e and the instructions, and applies the MCP write once, through err', async () => {
    const applyConfigWrite = vi.fn();
    const h = harness({ stored: 'pi', onPath: { pi: PI }, applyConfigWrite });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    const spec = h.runAgent.mock.calls[0]![0];
    expect(spec.bin).toBe('/usr/bin/pi');
    expect(spec.args).toEqual(['-e', '/cache/pi-align.ts', '--append-system-prompt', '/cache/align-instructions.md']);
    expect(applyConfigWrite).toHaveBeenCalledOnce();
    expect(applyConfigWrite.mock.calls[0]![0]).toMatchObject({ kind: 'mcp-entry', name: 'align-local', root: '/home/u' });
    // lines go to stderr, never stdout
    applyConfigWrite.mock.calls[0]![1]('hello');
    expect(h.err).toContain('hello');
  });

  it('launches cursor-agent with only the user\'s args and applies the one MCP write', async () => {
    const applyConfigWrite = vi.fn();
    const h = harness({ stored: 'cursor', onPath: { 'cursor-agent': CURSOR }, applyConfigWrite, argv: ['node', 'align', '--', 'fix it'] });
    await launchIfChosen(h.deps);
    expect(h.runAgent.mock.calls[0]![0].args).toEqual(['fix it']);
    expect(applyConfigWrite.mock.calls.map((c) => c[0].kind)).toEqual(['mcp-entry']);
  });

  it('a dry run (and the trace) changes nothing in the user\'s config', async () => {
    const applyConfigWrite = vi.fn();
    const h = harness({ stored: 'pi', onPath: { pi: PI }, applyConfigWrite, env: { ALIGN_LAUNCH_DRY_RUN: '1' } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(applyConfigWrite).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();
  });

  it('nothing to write when the agent already has everything: no applyConfigWrite call', async () => {
    const applyConfigWrite = vi.fn();
    const h = harness({
      stored: 'pi', onPath: { pi: PI }, applyConfigWrite,
      readPiState: () => ({ projectHasExtension: true, projectHasMcp: true, projectHasBlock: true, mcpAdapterInstalled: true, mcpFile: '/x' }),
    });
    await launchIfChosen(h.deps);
    expect(applyConfigWrite).not.toHaveBeenCalled();
    expect(h.runAgent.mock.calls[0]![0].args).toEqual([]);
  });

  it('a write that throws is reported with the file and the session still opens (two failures)', async () => {
    for (const message of ['changed by another program', 'invalid JSON']) {
      const h = harness({ stored: 'pi', onPath: { pi: PI }, applyConfigWrite: () => { throw new Error(message); } });
      expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
      expect(h.err.join('\n')).toContain('/home/u/.pi/agent/mcp.json');
      expect(h.err.join('\n')).toContain(message);
      expect(h.runAgent).toHaveBeenCalledOnce();
    }
  });

  it('ALIGN_WRAPPED stops the launch before any write', async () => {
    const applyConfigWrite = vi.fn();
    const h = harness({ stored: 'pi', onPath: { pi: PI }, applyConfigWrite, env: { ALIGN_WRAPPED: '1' } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(applyConfigWrite).not.toHaveBeenCalled();
  });

  it('preselects pi when it is the only supported agent installed, and offers pi beside claude when both are', async () => {
    const only = harness({ onPath: { pi: PI } });
    await launchIfChosen(only.deps);
    expect(only.pick.mock.calls[0]![1]).toBe('pi');
    expect(only.setAgent).toHaveBeenCalledWith('pi');
    const both = harness({ onPath: { pi: PI, claude: CLAUDE } });
    both.pick.mockResolvedValue('pi');
    await launchIfChosen(both.deps);
    expect(both.pick.mock.calls[0]![0].filter((o: { hint?: string }) => !o.hint).map((o: { value: string }) => o.value)).toEqual(['claude-code', 'pi']);
  });

  it('offers cursor when cursor-agent is installed', async () => {
    const h = harness({ onPath: { 'cursor-agent': CURSOR, claude: CLAUDE } });
    h.pick.mockResolvedValue(null);
    await launchIfChosen(h.deps);
    expect(h.pick.mock.calls[0]![0].filter((o: { hint?: string }) => !o.hint).map((o: { value: string }) => o.value)).toEqual(['claude-code', 'cursor']);
  });
});

describe('launchIfChosen: after align use --undo (C4)', () => {
  it('with launching off and no agent chosen, bare align neither writes nor launches, even with one agent installed', async () => {
    const applyConfigWrite = vi.fn();
    const h = harness({ onPath: { pi: '/usr/bin/pi' }, applyConfigWrite, config: { getAgent: () => undefined, setAgent: vi.fn(), isLaunchOff: () => true } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(applyConfigWrite).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.deps.config.setAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('align use <agent>');
  });

  it('an explicit `align -- ...` is not launched while off, and does not silently drop its arguments: it exits 1', async () => {
    const h = harness({ onPath: { pi: '/usr/bin/pi' }, argv: ['node', 'align', '--', 'hi'], config: { getAgent: () => undefined, setAgent: vi.fn(), isLaunchOff: () => true } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 1 });
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('align use <agent>');
  });

  it('with launching on (not off) the same machine auto-picks and launches', async () => {
    const h = harness({ onPath: { pi: '/usr/bin/pi' }, config: { getAgent: () => undefined, setAgent: vi.fn(), isLaunchOff: () => false } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.runAgent).toHaveBeenCalledOnce();
  });
});

describe('launchIfChosen: Cursor\'s binary name (C4)', () => {
  it('runs cursor-agent; a bare `agent` on PATH is NOT Cursor (never run an unknown binary)', async () => {
    const ok = harness({ stored: 'cursor', onPath: { 'cursor-agent': '/usr/bin/cursor-agent' } });
    await launchIfChosen(ok.deps);
    expect(ok.runAgent.mock.calls[0]![0].bin).toBe('/usr/bin/cursor-agent');
    const onlyAgent = harness({ stored: 'cursor', onPath: { agent: '/usr/bin/agent' }, argv: ['node', 'align', '--', 'x'] });
    expect(await launchIfChosen(onlyAgent.deps)).toEqual({ handled: true, code: 127 });
    expect(onlyAgent.runAgent).not.toHaveBeenCalled();
  });

  it('does not count a bare `agent` as installed Cursor (claude is the one installed, so preselected)', async () => {
    const no = harness({ onPath: { agent: '/usr/bin/agent', claude: CLAUDE } });
    await launchIfChosen(no.deps);
    expect(no.pick.mock.calls[0]![1]).toBe('claude-code'); // claude is the only installed candidate
    expect(no.pick.mock.calls[0]![0].find((o: { value: string }) => o.value === 'cursor').label).toBe('Cursor (not installed)');
    expect(no.setAgent).toHaveBeenCalledWith('claude-code');
  });
});

describe('launchIfChosen: the picker lists every agent (phase P)', () => {
  const ALL = ['aider', 'amp', 'auggie', 'claude-code', 'cline', 'codex', 'continue', 'copilot', 'cursor', 'droid', 'gemini-cli', 'goose', 'grok-build', 'kiro', 'opencode', 'pi', 'qwen'];
  const values = (opts: Array<{ value: string }>) => opts.map((o) => o.value).sort();

  it('on a TTY with none installed, opens the picker with every supported agent, each marked not installed', async () => {
    const h = harness({ onPath: {} });
    h.pick.mockResolvedValue(null);
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 1 });
    const opts = h.pick.mock.calls[0]![0] as Array<{ value: string; hint?: string }>;
    expect(values(opts)).toEqual(ALL);
    expect(opts.every((o) => o.hint?.startsWith('install: '))).toBe(true);
    expect((opts as Array<{ label: string }>).every((o) => o.label.endsWith(' (not installed)'))).toBe(true);
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('on a TTY with two installed, lists those two first and every other agent after them', async () => {
    const h = harness({ onPath: { claude: CLAUDE, opencode: '/usr/bin/opencode' } });
    h.pick.mockResolvedValue('opencode');
    await launchIfChosen(h.deps);
    const opts = h.pick.mock.calls[0]![0] as Array<{ value: string }>;
    expect(opts.slice(0, 2).map((o) => o.value)).toEqual(['claude-code', 'opencode']);
    expect(values(opts)).toEqual(ALL);
  });
  it('picking a missing npm agent asks first; on yes it runs that argv with no shell, re-detects and opens it', async () => {
    const onPath: Record<string, string> = { npm: '/usr/bin/npm' };
    const spawnInstall = vi.fn(() => {
      onPath['codex'] = '/usr/bin/codex';
      const child = { on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') queueMicrotask(() => cb(0)); return child; } };
      return child as never;
    });
    const confirm = vi.fn(async () => true);
    const h = harness({ onPath, confirm, spawnInstall });
    h.pick.mockResolvedValueOnce('codex');
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(confirm).toHaveBeenCalledExactlyOnceWith('Install Codex now? (runs: npm i -g @openai/codex)');
    expect(spawnInstall).toHaveBeenCalledExactlyOnceWith('/usr/bin/npm', ['i', '-g', '@openai/codex'], expect.objectContaining({ shell: false, stdio: 'inherit' }));
    expect(h.setAgent).toHaveBeenCalledWith('codex');
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('/usr/bin/codex');
  });
  it('Ctrl-C at the install question exits with code 1: no install, no second picker', async () => {
    const spawnInstall = vi.fn();
    const confirm = vi.fn(async () => null);
    const h = harness({ onPath: { npm: '/usr/bin/npm', claude: CLAUDE }, confirm, spawnInstall });
    h.pick.mockResolvedValueOnce('gemini-cli');
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 1 });
    expect(spawnInstall).not.toHaveBeenCalled();
    expect(h.pick).toHaveBeenCalledTimes(1);
    expect(h.runAgent).not.toHaveBeenCalled();
  });
  it('on no, installs nothing and returns to the picker', async () => {
    const spawnInstall = vi.fn();
    const confirm = vi.fn(async () => false);
    const h = harness({ onPath: { npm: '/usr/bin/npm' }, confirm, spawnInstall });
    h.pick.mockResolvedValueOnce('gemini-cli').mockResolvedValueOnce(null);
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 1 });
    expect(spawnInstall).not.toHaveBeenCalled();
    expect(h.pick).toHaveBeenCalledTimes(2);
  });
  it('picking a missing script-installed agent prints its docs on stderr and returns to the picker, never asking', async () => {
    const spawnInstall = vi.fn();
    const confirm = vi.fn();
    const h = harness({ onPath: { npm: '/usr/bin/npm' }, confirm, spawnInstall });
    h.pick.mockResolvedValueOnce('cursor').mockResolvedValueOnce(null);
    await launchIfChosen(h.deps);
    expect(confirm).not.toHaveBeenCalled();
    expect(spawnInstall).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('https://cursor.com/cli');
    expect(h.logSpy).not.toHaveBeenCalled();
  });
});
