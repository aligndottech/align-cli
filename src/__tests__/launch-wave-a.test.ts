import { describe, expect, it, vi } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';
import { supportedAgents } from '../lib/launch/agents.js';
import { geminiCopyName } from '../lib/launch/gemini-state.js';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import { pickAgent } from '../lib/launch/pick-agent.js';
import { AGENT_REGISTRY } from '../lib/launch/registry/index.js';

/*
 * Wave A wiring: Codex, Gemini CLI and GitHub Copilot CLI are launch targets, so the picker
 * (bare `align` and the first-run wizard) offers them when installed and not when absent, and
 * `align use <agent>` stores them. Each launch carries ALIGN_WRAPPED and writes nothing to stdout.
 */
const WAVE_A = ['codex', 'gemini-cli', 'copilot'] as const;
const BINS: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini', copilot: 'copilot' };

function harness(over: Partial<LaunchDeps> & { stored?: string; onPath?: string[] } = {}) {
  let stored = over.stored;
  const onPath = over.onPath ?? ['claude'];
  const err: string[] = [];
  const written: Array<[string, string]> = [];
  const modes: Record<string, number | undefined> = {};
  const pruned: Array<{ prefix: string; keep?: string; remove?: string }> = [];
  const runAgent = vi.fn().mockResolvedValue(0);
  const pick = vi.fn();
  const deps: LaunchDeps = {
    env: {},
    argv: ['node', 'align'],
    cwd: '/proj',
    home: '/home/u',
    platform: 'linux',
    isTTY: true,
    config: { getAgent: () => stored, setAgent: (a) => { stored = a; } },
    findOnPath: (bin) => (onPath.includes(bin) ? `/usr/bin/${bin}` : null),
    readProjectState: () => ({ projectHasPreHook: false, projectHasPostHook: false, projectHasMcp: false, projectHasBlock: false }),
    readOpenCodeState: () => ({ projectHasPlugin: false, projectHasMcp: false, projectHasBlock: false }),
    readPiState: () => ({ projectHasExtension: false, projectHasMcp: false, projectHasBlock: false, mcpAdapterInstalled: true, mcpFile: '/home/u/.pi/agent/mcp.json' }),
    readCursorState: () => ({ projectHasMcp: false, mcpFile: '/home/u/.cursor/mcp.json' }),
    readCodexState: () => ({ present: false, overridden: [] }),
    readGeminiState: () => ({ present: false, overridden: [], systemSettings: { path: '/etc/gemini-cli/settings.json', text: null, unreadable: false }, trust: 'untrusted' }),
    readCopilotState: () => ({ present: false, overridden: [] }),
    pruneLaunchFiles: (_d, prefix, opts) => { pruned.push({ prefix, keep: opts.keep, remove: opts.remove }); },
    applyConfigWrite: vi.fn(),
    cacheDir: () => '/cache',
    writeIfChanged: (_d, name, content, opts) => { written.push([name, content]); modes[name] = opts?.mode; return true; },
    runAgent,
    record: vi.fn(),
    pick,
    err: (l) => err.push(l),
    now: () => 42,
    ...over,
  };
  return { deps, err, written, modes, pruned, runAgent, pick, stored: () => stored };
}

describe('wave A: the registry', () => {
  it('Codex, Gemini CLI and Copilot are supported launch targets with an adapter', () => {
    for (const name of WAVE_A) {
      const spec = AGENT_REGISTRY.find((a) => a.name === name);
      expect(spec?.supported, name).toBe(true);
      expect(typeof spec?.build, name).toBe('function');
    }
  });
  it('Copilot runs `copilot` and installs from npm', () => {
    expect(AGENT_REGISTRY.find((a) => a.name === 'copilot')).toMatchObject({ label: 'GitHub Copilot CLI', bin: 'copilot', install: 'npm i -g @github/copilot', injection: 'per-session' });
  });
});

describe('wave A: the picker offers them when installed, and not when absent', () => {
  it('bare `align` offers Claude Code, Codex, GitHub Copilot CLI and Gemini CLI when all four are on PATH', async () => {
    const h = harness({ onPath: ['claude', 'codex', 'gemini', 'copilot'] });
    h.pick.mockResolvedValue('codex');
    await launchIfChosen(h.deps);
    expect(h.pick.mock.calls[0]![0].map((a: { label: string }) => a.label)).toEqual(['Claude Code', 'Codex', 'GitHub Copilot CLI', 'Gemini CLI']);
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('codex');
  });
  it('bare `align` does not offer them when they are not on PATH (only Claude: no picker at all)', async () => {
    const h = harness({ onPath: ['claude'] });
    await launchIfChosen(h.deps);
    expect(h.pick).not.toHaveBeenCalled();
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('claude');
  });
  it('the wizard offers the installed ones from the same table', async () => {
    const select = vi.fn().mockResolvedValue('gemini-cli');
    let stored: string | undefined;
    const config = { getAgent: () => stored, setAgent: (a: string) => { stored = a; } };
    const onPath = ['gemini', 'codex'];
    const r = await pickAgent(config, { interactive: true }, { agents: supportedAgents(), env: {}, platform: 'linux', findOnPath: (b) => (onPath.includes(b) ? `/b/${b}` : null), select, say: () => {} });
    expect(select.mock.calls[0]![0].map((a: { name: string }) => a.name)).toEqual(['codex', 'gemini-cli']);
    expect(r).toBe('gemini-cli');
  });
  it('the wizard does not offer one that is absent (only Copilot installed: picked without asking)', async () => {
    const select = vi.fn();
    let stored: string | undefined;
    const config = { getAgent: () => stored, setAgent: (a: string) => { stored = a; } };
    const r = await pickAgent(config, { interactive: true }, { agents: supportedAgents(), env: {}, platform: 'linux', findOnPath: (b) => (b === 'copilot' ? '/b/copilot' : null), select, say: () => {} });
    expect(select).not.toHaveBeenCalled();
    expect(r).toBe('copilot');
  });
});

describe('wave A: each launches with Align wired in', () => {
  it.each(WAVE_A)('%s: spawns its own binary with ALIGN_WRAPPED=1 and writes nothing to stdout by any route', async (name) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const h = harness({ stored: name, onPath: [BINS[name]!] });
      expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
      const spec = h.runAgent.mock.calls[0]![0];
      expect(spec.bin).toBe(BINS[name]);
      expect(spec.env['ALIGN_WRAPPED']).toBe('1');
      expect(JSON.stringify(spec)).toContain('align-local');
      expect(log).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  });
  it('control for the stdout check: the write spy DOES see a direct write (vitest routes console.log elsewhere, hence both spies)', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.stdout.write('x');
      expect(write).toHaveBeenCalledWith('x');
    } finally {
      write.mockRestore();
    }
  });
  it('codex: the -c overrides come before the user\'s args', async () => {
    const h = harness({ stored: 'codex', onPath: ['codex'], argv: ['node', 'align', '--', 'resume', '--last'] });
    await launchIfChosen(h.deps);
    const args: string[] = h.runAgent.mock.calls[0]![0].args;
    expect(args[0]).toBe('-c');
    expect(args.slice(-2)).toEqual(['resume', '--last']);
  });
  it('gemini: writes the merged system copy 0600, points the env at it, and the trust line goes to stderr', async () => {
    const h = harness({ stored: 'gemini-cli', onPath: ['gemini'] });
    await launchIfChosen(h.deps);
    const name = geminiCopyName('/etc/gemini-cli/settings.json');
    expect(h.written.map(([n]) => n)).toEqual([name]);
    expect(h.modes[name]).toBe(0o600);
    expect(h.runAgent.mock.calls[0]![0].env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']).toBe(`/cache/${name}`);
    expect(h.err.some((l) => l.includes('Trust this folder in Gemini'))).toBe(true);
  });
  it('gemini: keeps (and refreshes) this source\'s copy when injecting; removes only it when not', async () => {
    const h = harness({ stored: 'gemini-cli', onPath: ['gemini'], readGeminiState: () => ({ present: true, overridden: [], systemSettings: { path: '/etc/gemini-cli/settings.json', text: null, unreadable: false }, trust: 'trusted' }) });
    await launchIfChosen(h.deps);
    expect(h.pruned).toEqual([{ prefix: 'gemini-system-settings-', keep: undefined, remove: geminiCopyName('/etc/gemini-cli/settings.json') }]);
    const i = harness({ stored: 'gemini-cli', onPath: ['gemini'] });
    await launchIfChosen(i.deps);
    expect(i.pruned).toEqual([{ prefix: 'gemini-system-settings-', keep: geminiCopyName('/etc/gemini-cli/settings.json'), remove: undefined }]);
  });
  it('copilot: writes its launch file and passes it with @', async () => {
    const h = harness({ stored: 'copilot', onPath: ['copilot'] });
    await launchIfChosen(h.deps);
    expect(h.written.map(([n]) => n)).toEqual(['copilot-mcp.json']);
    expect(h.runAgent.mock.calls[0]![0].args.slice(0, 2)).toEqual(['--additional-mcp-config', '@/cache/copilot-mcp.json']);
  });
  it('align\'s own local entry already loaded suppresses the injection end to end (codex, copilot)', async () => {
    const c = harness({ stored: 'codex', onPath: ['codex'], readCodexState: () => ({ present: true, overridden: [] }) });
    await launchIfChosen(c.deps);
    expect(c.runAgent.mock.calls[0]![0].args).toEqual([]);
    const p = harness({ stored: 'copilot', onPath: ['copilot'], readCopilotState: () => ({ present: true, overridden: [] }) });
    await launchIfChosen(p.deps);
    expect(p.written).toEqual([]);
  });
  it('a conflicting align-local still launches the agent, without Align, and says why on stderr', async () => {
    const c = harness({ stored: 'codex', onPath: ['codex'], readCodexState: () => ({ present: false, overridden: [], conflict: '/r/.codex/config.toml' }) });
    expect(await launchIfChosen(c.deps)).toEqual({ handled: true, code: 0 });
    expect(c.runAgent.mock.calls[0]![0].args).toEqual([]);
    expect(c.err.join('\n')).toContain('/r/.codex/config.toml redefines the align-local MCP server');
  });

  it('the codex reader gets the user\'s args (a -p profile adds a config layer)', async () => {
    const seen: string[][] = [];
    const h = harness({ stored: 'codex', onPath: ['codex'], argv: ['node', 'align', '--', '-p', 'work', 'exec', 'x'], readCodexState: (_c, _h, _e, _p, passthrough) => { seen.push(passthrough); return { present: false, overridden: [] }; } });
    await launchIfChosen(h.deps);
    expect(seen).toEqual([['-p', 'work', 'exec', 'x']]);
  });

  it('the state readers get the platform (win32 decides what counts as present)', async () => {
    const seen: string[] = [];
    const h = harness({ stored: 'codex', onPath: ['codex'], platform: 'win32', readCodexState: (_c, _h, _e, platform) => { seen.push(platform); return { present: false, overridden: [] }; } });
    await launchIfChosen(h.deps);
    const p = harness({ stored: 'copilot', onPath: ['copilot'], platform: 'darwin', readCopilotState: (_c, _h, _e, platform) => { seen.push(platform); return { present: false, overridden: [] }; } });
    await launchIfChosen(p.deps);
    expect(seen).toEqual(['win32', 'darwin']);
  });
});

describe('wave A: a state reader or adapter that throws', () => {
  it('still launches the agent, without Align, with one stderr line and no stack trace', async () => {
    const h = harness({ stored: 'codex', onPath: ['codex'], argv: ['node', 'align', '--', 'resume'], readCodexState: () => { throw new TypeError('Cannot convert undefined or null to object'); } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.runAgent.mock.calls[0]![0]).toEqual({ bin: 'codex', args: ['resume'], env: { ALIGN_WRAPPED: '1' }, files: [] });
    expect(h.err).toEqual(["Could not prepare Align for Codex (Cannot convert undefined or null to object). Opening it without Align's graph."]);
  });
  it('the same for a repo .mcp.json holding an own __proto__ key, end to end through the real reader', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { readCopilotState } = await import('../lib/launch/copilot-state.js');
    const root = mkdtempSync(path.join(os.tmpdir(), 'align-proto-'));
    try {
      mkdirSync(path.join(root, '.git'));
      writeFileSync(path.join(root, '.mcp.json'), '{"mcpServers":{"align-local":{"__proto__":{}}}}');
      const h = harness({ stored: 'copilot', onPath: ['copilot'], cwd: root, readCopilotState: (c, hm, e, p) => readCopilotState(c, hm, { localIsDefault: false }, e, p) });
      expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
      expect(h.runAgent).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('wave A: no terminal, several installed (scripted first runs keep working)', () => {
  const noTty = (onPath: string[]) => harness({ onPath, isTTY: false, argv: ['node', 'align', '--', '-p', 'hi'] });
  it('picks by the old priority, Claude Code first, then names it and how to change it on stderr', async () => {
    const h = noTty(['claude', 'codex', 'gemini', 'copilot']);
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('claude');
    expect(h.err).toEqual(['Opening Claude Code: more than one coding agent is installed and there is no terminal to ask. Change it with: align use <agent>']);
    expect(h.pick).not.toHaveBeenCalled();
  });
  it('an agent from before wave A comes ahead of the new ones (OpenCode over Codex and Gemini)', async () => {
    const h = noTty(['gemini', 'codex', 'opencode']);
    await launchIfChosen(h.deps);
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('opencode');
  });
  it('among the new ones only: Codex, then Copilot, then Gemini CLI', async () => {
    const h = noTty(['gemini', 'copilot']);
    await launchIfChosen(h.deps);
    expect(h.runAgent.mock.calls[0]![0].bin).toBe('copilot');
  });
  it('on a TTY it still asks', async () => {
    const h = harness({ onPath: ['claude', 'codex'], isTTY: true });
    h.pick.mockResolvedValue('codex');
    await launchIfChosen(h.deps);
    expect(h.pick).toHaveBeenCalledTimes(1);
  });
});

describe('wave A: the wizard without a terminal', () => {
  const run = (onPath: string[], opts: { approve?: boolean }) => {
    let stored: string | undefined;
    const say: string[] = [];
    const config = { getAgent: () => stored, setAgent: (a: string) => { stored = a; } };
    return pickAgent(config, { interactive: false, ...opts }, { agents: supportedAgents(), env: {}, platform: 'linux', findOnPath: (b) => (onPath.includes(b) ? `/b/${b}` : null), select: vi.fn(), say: (l) => say.push(l) }).then((r) => ({ r, say }));
  };
  it('--approve picks by the same priority: OpenCode over Codex, Codex over Gemini', async () => {
    expect((await run(['codex', 'opencode'], { approve: true })).r).toBe('opencode');
    expect((await run(['gemini', 'codex'], { approve: true })).r).toBe('codex');
  });
  it('no --approve: a machine with Claude Code plus a new agent still gets Claude Code, as before wave A', async () => {
    const { r, say } = await run(['claude', 'codex', 'gemini'], {});
    expect(r).toBe('claude-code');
    expect(say.join('\n')).toContain('Claude Code');
  });
  it('no --approve: two agents from before wave A still does not guess (unchanged)', async () => {
    expect((await run(['claude', 'opencode'], {})).r).toBeNull();
  });
});

describe('wave A: align use', () => {
  const useDeps = (onPath: string[], store: { v?: string }): UseDeps => ({
    config: { getAgent: () => store.v, setAgent: (a) => { store.v = a; }, clearAgent: () => {}, setLaunchOff: () => {}, clearRefusedWrites: () => {} },
    writtenConfigs: { get: () => ({}), drop: () => {} },
    findOnPath: (b) => (onPath.includes(b) ? `/b/${b}` : null),
    env: {},
    platform: 'linux',
    log: () => {},
    err: () => {},
  });
  it.each(WAVE_A)('stores %s when it is on PATH', async (name) => {
    const store: { v?: string } = {};
    expect(await runUse(name, useDeps([BINS[name]!], store))).toBe(0);
    expect(store.v).toBe(name);
  });
  it('refuses copilot when it is not on PATH', async () => {
    const store: { v?: string } = {};
    expect(await runUse('copilot', useDeps([], store))).toBe(1);
    expect(store.v).toBeUndefined();
  });
});
