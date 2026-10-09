import { describe, expect, it, vi } from 'vitest';
import { pickAgent, type PickAgentDeps } from '../lib/launch/pick-agent.js';
import { LAUNCH_AGENTS, type LaunchAgent } from '../lib/launch/agents.js';

// Two supported agents, so the several-installed branches are reachable today (C1 ships one).
const CLAUDE = LAUNCH_AGENTS.find((a) => a.name === 'claude-code')!;
const OPENCODE: LaunchAgent = { ...LAUNCH_AGENTS.find((a) => a.name === 'opencode')!, supported: true };
const CODEX: LaunchAgent = { ...LAUNCH_AGENTS.find((a) => a.name === 'codex')!, supported: true };

function harness(over: Partial<PickAgentDeps> & { stored?: string; onPath?: string[]; agents?: LaunchAgent[] } = {}) {
  let stored = over.stored;
  const onPath = over.onPath ?? ['claude'];
  const say: string[] = [];
  const select = vi.fn<PickAgentDeps['select']>();
  const setAgent = vi.fn((a: string) => { stored = a; });
  const deps: PickAgentDeps = {
    env: {},
    platform: 'linux',
    agents: over.agents ?? [CLAUDE, OPENCODE],
    findOnPath: (bin) => (onPath.includes(bin) ? `/bin/${bin}` : null),
    select,
    say: (l) => say.push(l),
    ...over,
  };
  const config = { getAgent: () => stored, setAgent };
  return { deps, config, say, select, setAgent, stored: () => stored };
}

describe('pickAgent: how many agents are installed', () => {
  it('auto-picks and stores the only installed supported agent, without asking', async () => {
    const h = harness({ onPath: ['claude'] });
    const r = await pickAgent(h.config, { interactive: true }, h.deps);
    expect(r).toBe('claude-code');
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('auto-picks the other one when that is the only one installed (two examples)', async () => {
    const h = harness({ onPath: ['opencode'] });
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe('opencode');
    expect(h.stored()).toBe('opencode');
  });
  it('with two installed on a TTY, offers exactly those two and stores the answer', async () => {
    const h = harness({ onPath: ['claude', 'opencode'], agents: [CLAUDE, OPENCODE, CODEX] });
    h.select.mockResolvedValue('opencode');
    const r = await pickAgent(h.config, { interactive: true }, h.deps);
    expect(h.select.mock.calls[0]![0].map((a) => a.name)).toEqual(['claude-code', 'opencode']);
    expect(r).toBe('opencode');
    expect(h.stored()).toBe('opencode');
  });
  it('a cancelled picker stores nothing', async () => {
    const h = harness({ onPath: ['claude', 'opencode'] });
    h.select.mockResolvedValue(null);
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBeNull();
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('with none installed, names the supported agents with install hints and leaves agent unset', async () => {
    const h = harness({ onPath: [] });
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBeNull();
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
  it('a stored name that is not a launch target any more is ignored', async () => {
    const h = harness({ stored: 'nonsense', onPath: ['claude'] });
    expect(await pickAgent(h.config, { interactive: true }, h.deps)).toBe('claude-code');
  });
});
