import { describe, expect, it, vi } from 'vitest';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';

const CLAUDE = '/usr/bin/claude';
function harness(over: Partial<LaunchDeps> & { stored?: string; onPath?: Record<string, string> } = {}) {
  let stored = over.stored;
  const onPath = over.onPath ?? { claude: CLAUDE };
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const written: Array<[string, string]> = [];
  const runAgent = vi.fn().mockResolvedValue(0);
  const record = vi.fn();
  const pick = vi.fn();
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
    cacheDir: () => '/cache',
    writeIfChanged: (_d, name, content) => { written.push([name, content]); return true; },
    runAgent,
    record,
    pick,
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
    expect(spec.bin).toBe('claude');
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
  it('falls back to the card with one line when the chosen agent is not a launch target yet', async () => {
    const h = harness({ stored: 'codex' });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: false });
    expect(h.out.join('\n')).toMatch(/Codex.*not.*yet|coming soon/i);
    expect(h.runAgent).not.toHaveBeenCalled();
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
  it('auto-picks the one supported agent on PATH, stores it, says so, launches, never prompts', async () => {
    const h = harness({ isTTY: true });
    const r = await launchIfChosen(h.deps);
    expect(r).toEqual({ handled: true, code: 0 });
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(h.stored()).toBe('claude-code');
    expect(h.out.join('\n')).toBe('Opening Claude Code. Switch any time with `align use`.');
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.pick).not.toHaveBeenCalled();
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
  it('does not auto-pick when none is installed: lists what works, how to install, exits non-zero', async () => {
    const h = harness({ onPath: {} });
    const r = await launchIfChosen(h.deps);
    expect(r).toEqual({ handled: true, code: 1 });
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('Claude Code');
    expect(h.err.join('\n')).toContain('npm i -g @anthropic-ai/claude-code');
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
    expect(h.pick.mock.calls[0]![0].map((a: { name: string }) => a.name)).toEqual(['claude-code', 'opencode']);
    expect(h.setAgent).toHaveBeenCalledWith('opencode');
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('opencode');
  });
  it('does not guess without a TTY: 3-line hint on stderr, exit 2, nothing stored or launched', async () => {
    const h = two({ isTTY: false, argv: ['node', 'align', '--', 'x'] });
    const r = await launchIfChosen(h.deps);
    expect(r).toEqual({ handled: true, code: 2 });
    expect(h.err).toHaveLength(3);
    expect(h.pick).not.toHaveBeenCalled();
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();
  });
});

describe('launchIfChosen: OpenCode (C2)', () => {
  const OC = '/usr/bin/opencode';
  it('auto-picks opencode when it is the only supported agent on PATH', async () => {
    const h = harness({ onPath: { opencode: OC } });
    await launchIfChosen(h.deps);
    expect(h.setAgent).toHaveBeenCalledWith('opencode');
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('opencode');
  });
  it('spawns opencode with OPENCODE_CONFIG_CONTENT and OPENCODE_CONFIG_DIR in the env, and writes the launch files', async () => {
    const h = harness({ stored: 'opencode', onPath: { opencode: OC } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    const spec = h.runAgent.mock.calls[0]![0];
    expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT).mcp['align-local'].command[0]).toBe('align');
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
    ['the auto-pick announcement', {}],
    ['the trace line', { stored: 'claude-code', env: { ALIGN_LAUNCH_TRACE: '1' } }],
    ['the coming-soon note', { stored: 'codex' }],
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
