import { describe, expect, it, vi } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';

function harness(stored?: string, onPath: Record<string, string> = { claude: '/usr/bin/claude' }) {
  let current = stored;
  const out: string[] = [];
  const err: string[] = [];
  const clearAgent = vi.fn(() => { current = undefined; });
  const setAgent = vi.fn((a: string) => { current = a; });
  const deps: UseDeps = {
    config: { getAgent: () => current, setAgent, clearAgent },
    findOnPath: (bin) => onPath[bin] ?? null,
    env: {},
    platform: 'linux',
    log: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, setAgent, clearAgent, current: () => current };
}

describe('align use', () => {
  it('stores claude-code when it is on PATH', async () => {
    const h = harness();
    expect(await runUse('claude-code', h.deps)).toBe(0);
    expect(h.setAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(h.out.join('\n')).toContain('Claude Code');
  });
  it('refuses claude-code when it is not on PATH: exit 1, config unchanged, install hint', async () => {
    const h = harness('claude-code', {});
    expect(await runUse('claude-code', h.deps)).toBe(1);
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('npm i -g @anthropic-ai/claude-code');
  });
  it.each(['codex', 'opencode'])('reports %s as coming soon and stores nothing', async (name) => {
    const h = harness('claude-code', { codex: '/bin/codex', opencode: '/bin/opencode', claude: '/bin/claude' });
    expect(await runUse(name, h.deps)).toBe(1);
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.current()).toBe('claude-code');
    expect(h.err.join('\n')).toMatch(/coming soon/);
  });
  it('rejects an unknown name, listing the valid ones, and stores nothing', async () => {
    const h = harness();
    expect(await runUse('emacs', h.deps)).toBe(1);
    expect(h.setAgent).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('claude-code');
    expect(h.err.join('\n')).toContain('codex');
  });
  it('with no argument prints the current choice', async () => {
    const h = harness('claude-code');
    expect(await runUse(undefined, h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('claude-code');
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('with no argument and nothing chosen says so and how it gets chosen', async () => {
    const h = harness(undefined);
    expect(await runUse(undefined, h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/No agent chosen/);
  });

  it('--none clears the choice, so bare `align` picks again', async () => {
    const h = harness('claude-code');
    expect(await runUse(undefined, h.deps, { none: true })).toBe(0);
    expect(h.clearAgent).toHaveBeenCalledTimes(1);
    expect(h.current()).toBeUndefined();
    expect(h.out.join('\n')).toMatch(/cleared/i);
  });
  it('--none with an agent name is a usage error and changes nothing', async () => {
    const h = harness('claude-code');
    expect(await runUse('claude-code', h.deps, { none: true })).toBe(2);
    expect(h.clearAgent).not.toHaveBeenCalled();
    expect(h.setAgent).not.toHaveBeenCalled();
  });
  it('without --none nothing is ever cleared', async () => {
    const h = harness('claude-code');
    await runUse('claude-code', h.deps);
    await runUse(undefined, h.deps);
    await runUse('codex', h.deps);
    expect(h.clearAgent).not.toHaveBeenCalled();
  });
});
