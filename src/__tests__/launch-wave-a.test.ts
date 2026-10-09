import { describe, expect, it, vi } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';
import { supportedAgents } from '../lib/launch/agents.js';
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
    readCodexState: () => ({ projectHasMcp: false }),
    readGeminiState: () => ({ projectHasMcp: false, systemSettings: { path: '/etc/gemini-cli/settings.json', text: null, unreadable: false }, trust: 'untrusted' }),
    readCopilotState: () => ({ projectHasMcp: false }),
    applyConfigWrite: vi.fn(),
    cacheDir: () => '/cache',
    writeIfChanged: (_d, name, content) => { written.push([name, content]); return true; },
    runAgent,
    record: vi.fn(),
    pick,
    err: (l) => err.push(l),
    now: () => 42,
    ...over,
  };
  return { deps, err, written, runAgent, pick, stored: () => stored };
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
  it.each(WAVE_A)('%s: spawns its own binary with ALIGN_WRAPPED=1 and prints nothing to stdout', async (name) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness({ stored: name, onPath: [BINS[name]!] });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    const spec = h.runAgent.mock.calls[0]![0];
    expect(spec.bin).toBe(BINS[name]);
    expect(spec.env['ALIGN_WRAPPED']).toBe('1');
    expect(JSON.stringify(spec)).toContain('align-local');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('codex: the -c overrides come before the user\'s args', async () => {
    const h = harness({ stored: 'codex', onPath: ['codex'], argv: ['node', 'align', '--', 'resume', '--last'] });
    await launchIfChosen(h.deps);
    const args: string[] = h.runAgent.mock.calls[0]![0].args;
    expect(args[0]).toBe('-c');
    expect(args.slice(-2)).toEqual(['resume', '--last']);
  });
  it('gemini: writes the merged system file, points the env at it, and the trust line goes to stderr', async () => {
    const h = harness({ stored: 'gemini-cli', onPath: ['gemini'] });
    await launchIfChosen(h.deps);
    expect(h.written.map(([n]) => n)).toEqual(['gemini-system-settings.json']);
    expect(h.runAgent.mock.calls[0]![0].env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']).toBe('/cache/gemini-system-settings.json');
    expect(h.err.some((l) => l.includes('trust this folder'))).toBe(true);
  });
  it('copilot: writes its launch file and passes it with @', async () => {
    const h = harness({ stored: 'copilot', onPath: ['copilot'] });
    await launchIfChosen(h.deps);
    expect(h.written.map(([n]) => n)).toEqual(['copilot-mcp.json']);
    expect(h.runAgent.mock.calls[0]![0].args.slice(0, 2)).toEqual(['--additional-mcp-config', '@/cache/copilot-mcp.json']);
  });
  it('an existing local entry suppresses the injection end to end (codex, copilot)', async () => {
    const c = harness({ stored: 'codex', onPath: ['codex'], readCodexState: () => ({ projectHasMcp: true }) });
    await launchIfChosen(c.deps);
    expect(c.runAgent.mock.calls[0]![0].args).toEqual([]);
    const p = harness({ stored: 'copilot', onPath: ['copilot'], readCopilotState: () => ({ projectHasMcp: true }) });
    await launchIfChosen(p.deps);
    expect(p.written).toEqual([]);
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
