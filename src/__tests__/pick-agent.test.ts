import { describe, expect, it, vi } from 'vitest';
import { PICK_CANCELLED, pickAgent, type PickAgentDeps } from '../lib/launch/pick-agent.js';
import { LAUNCH_AGENTS, type LaunchAgent } from '../lib/launch/agents.js';

// Two supported agents, so the several-installed branches are reachable today (C1 ships one).
const CLAUDE = LAUNCH_AGENTS.find((a) => a.name === 'claude-code')!;
const OPENCODE: LaunchAgent = { ...LAUNCH_AGENTS.find((a) => a.name === 'opencode')!, supported: true };
const CODEX: LaunchAgent = { ...LAUNCH_AGENTS.find((a) => a.name === 'codex')!, supported: true };

function harness(over: Partial<PickAgentDeps> & { stored?: string; onPath?: string[]; agents?: LaunchAgent[] } = {}) {
  let stored = over.stored;
  const onPath = over.onPath ?? ['claude'];
  const say: string[] = [];
  // Pressing Enter: the preselected row (the one installed agent), else nothing.
  const select = vi.fn<PickAgentDeps['select']>(async (_o, initial) => initial ?? null);
  const setAgent = vi.fn((a: string) => { stored = a; });
  const deps: PickAgentDeps = {
    env: {},
    platform: 'linux',
    agents: over.agents ?? [CLAUDE, OPENCODE],
    findOnPath: (bin) => (onPath.includes(bin) ? `/bin/${bin}` : null),
    select,
    say: (l) => say.push(l),
    confirm: vi.fn(async () => false),
    spawn: vi.fn(),
    ...over,
  };
  const config = { getAgent: () => stored, setAgent };
  return { deps, config, say, select, setAgent, stored: () => stored };
}

describe('pickAgent: how many agents are installed', () => {
  it('on a terminal with one installed, still asks, with it preselected; Enter stores it', async () => {
    const h = harness({ onPath: ['claude'] });
    const r = await pickAgent(h.config, { interactive: true }, h.deps);
    expect(r).toBe('claude-code');
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select.mock.calls[0]![1]).toBe('claude-code');
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
  });
  it('preselects the other one when that is the only one installed (two examples)', async () => {
    const h = harness({ onPath: ['opencode'] });
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe('opencode');
    expect(h.select.mock.calls[0]![1]).toBe('opencode');
    expect(h.stored()).toBe('opencode');
  });
  it('with two installed on a TTY, offers exactly those two and stores the answer', async () => {
    const h = harness({ onPath: ['claude', 'opencode'], agents: [CLAUDE, OPENCODE, CODEX] });
    h.select.mockResolvedValue('opencode');
    const r = await pickAgent(h.config, { interactive: true }, h.deps);
    expect(h.select.mock.calls[0]![0].filter((o: { hint?: string }) => !o.hint).map((o: { value: string }) => o.value)).toEqual(['claude-code', 'opencode']);
    expect(r).toBe('opencode');
    expect(h.stored()).toBe('opencode');
  });
  it('a cancelled picker reports the cancel, so the wizard can stop, and stores nothing', async () => {
    const h = harness({ onPath: ['claude', 'opencode'] });
    h.select.mockResolvedValue(null);
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe(PICK_CANCELLED);
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('with none installed and no terminal, names the supported agents with install hints and `align agents`, and leaves agent unset', async () => {
    const h = harness({ onPath: [] });
    expect(await pickAgent(h.config, { interactive: false }, h.deps)).toBeNull();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.say.join('\n')).toContain('align agents');
    expect(h.setAgent).not.toHaveBeenCalled();
    const said = h.say.join('\n');
    expect(said).toContain('Claude Code');
    expect(said).toContain(CLAUDE.install);
    expect(said).toContain('OpenCode');
    expect(said).toContain(OPENCODE.install);
  });
});

describe('pickAgent: no terminal', () => {
  it('--approve takes the first installed agent in table order, without asking', async () => {
    const h = harness({ onPath: ['opencode', 'claude'] });
    expect(await pickAgent(h.config, { interactive: false, approve: true }, h.deps)).toBe('claude-code');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('--approve with only the later agent installed takes that one (two examples)', async () => {
    const h = harness({ onPath: ['opencode'] });
    expect(await pickAgent(h.config, { interactive: false, approve: true }, h.deps)).toBe('opencode');
  });
  it('several installed and no terminal and no --approve: does not guess', async () => {
    const h = harness({ onPath: ['claude', 'opencode'] });
    expect(await pickAgent(h.config, { interactive: false }, h.deps)).toBeNull();
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.say.join('\n')).toContain('align use');
  });
  it('exactly one installed and no terminal still stores it (nothing to guess)', async () => {
    const h = harness({ onPath: ['claude'] });
    expect(await pickAgent(h.config, { interactive: false }, h.deps)).toBe('claude-code');
  });
});

describe('pickAgent: a re-run', () => {
  it('keeps an agent already chosen and asks nothing', async () => {
    const h = harness({ stored: 'opencode', onPath: ['claude', 'opencode'] });
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe('opencode');
    expect(h.select).not.toHaveBeenCalled();
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('a stored agent that is no longer on PATH is re-picked, as if none were stored', async () => {
    const h = harness({ stored: 'opencode', onPath: ['claude'] });
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe('claude-code');
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
  });
  it('a stored agent that is gone with nothing else installed prints the install hints once', async () => {
    const h = harness({ stored: 'claude-code', onPath: [] });
    expect(await pickAgent(h.config, { interactive: false }, h.deps)).toBeNull();
    expect(h.say.filter((l) => l.includes(CLAUDE.install))).toHaveLength(1);
  });
  it('a stored name that is not a launch target any more is ignored', async () => {
    const h = harness({ stored: 'nonsense', onPath: ['claude'] });
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe('claude-code');
  });
});

describe('pickAgent: after `align use --undo` (C4)', () => {
  it('says that choosing an agent turned launching back on (the wizard re-enables it), and says nothing when it was not off', async () => {
    const h = harness({ onPath: ['claude'] });
    await pickAgent({ ...h.config, isLaunchOff: () => true }, { interactive: true }, h.deps);
    expect(h.say.join('\n')).toContain('Launching is on again');
    const quiet = harness({ onPath: ['claude'] });
    await pickAgent({ ...quiet.config, isLaunchOff: () => false }, { interactive: true }, quiet.deps);
    expect(quiet.say.join('\n')).not.toContain('Launching is on again');
  });
});

describe('pickAgent: the picker lists every agent (phase P)', () => {
  it('on a terminal with none installed, opens the picker with every agent, each marked not installed; leaving it carries on with no agent', async () => {
    const h = harness({ onPath: [], agents: [CLAUDE, OPENCODE, CODEX] });
    h.select.mockResolvedValue(null);
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBeNull();
    expect(h.setAgent).not.toHaveBeenCalled();
    const opts = h.select.mock.calls[0]![0];
    expect(opts.map((o) => o.value)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(opts.map((o) => o.label)).toEqual(['Claude Code (not installed)', 'Codex (not installed)', 'OpenCode (not installed)']);
    expect(opts.map((o) => o.hint)).toEqual(['install: npm i -g @anthropic-ai/claude-code', 'install: npm i -g @openai/codex', 'install: npm i -g opencode-ai']);
  });
  it('with two installed, those come first and the missing one after them, marked', async () => {
    const h = harness({ onPath: ['claude', 'opencode'], agents: [CLAUDE, OPENCODE, CODEX] });
    h.select.mockResolvedValue('claude-code');
    await pickAgent(h.config, { interactive: true }, h.deps);
    const opts = h.select.mock.calls[0]![0];
    expect(opts.map((o) => o.value)).toEqual(['claude-code', 'opencode', 'codex']);
    expect(opts[2]).toEqual({ value: 'codex', label: 'Codex (not installed)', hint: 'install: npm i -g @openai/codex' });
  });
  it('picking a missing npm agent: yes runs exactly its argv with no shell, then stores it once found', async () => {
    const onPath = ['npm'];
    const spawn = vi.fn(() => {
      onPath.push('codex');
      const child = { on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') queueMicrotask(() => cb(0)); return child; } };
      return child as never;
    });
    const confirm = vi.fn(async () => true);
    const h = harness({ onPath, agents: [CLAUDE, CODEX], confirm, spawn });
    h.select.mockResolvedValueOnce('codex');
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe('codex');
    expect(confirm).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/bin/npm', ['i', '-g', '@openai/codex'], expect.objectContaining({ shell: false, stdio: 'inherit' }));
    expect(h.stored()).toBe('codex');
  });
  it('picking a missing npm agent: no spawns nothing and goes back to the picker', async () => {
    const spawn = vi.fn();
    const h = harness({ onPath: ['npm', 'claude', 'opencode'], agents: [CLAUDE, OPENCODE, CODEX], confirm: vi.fn(async () => false), spawn });
    h.select.mockResolvedValueOnce('codex').mockResolvedValueOnce(null);
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe(PICK_CANCELLED);
    expect(spawn).not.toHaveBeenCalled();
    expect(h.select).toHaveBeenCalledTimes(2);
  });
  it('Ctrl-C at the install question cancels the wizard: no install, no second picker', async () => {
    const spawn = vi.fn();
    const h = harness({ onPath: ['npm', 'claude'], agents: [CLAUDE, CODEX], confirm: vi.fn(async () => null), spawn });
    h.select.mockResolvedValueOnce('codex');
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe(PICK_CANCELLED);
    expect(spawn).not.toHaveBeenCalled();
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('--approve with one installed takes it without asking (unchanged)', async () => {
    const h = harness({ onPath: ['opencode'] });
    expect(await pickAgent(h.config, { interactive: true, approve: true }, h.deps)).toBe('opencode');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('--approve with none installed never opens the picker and never installs', async () => {
    const spawn = vi.fn();
    const h = harness({ onPath: ['npm'], confirm: vi.fn(async () => true), spawn });
    expect(await pickAgent(h.config, { interactive: true, approve: true }, h.deps)).toBeNull();
    expect(h.select).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
