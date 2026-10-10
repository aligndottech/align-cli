import { describe, expect, it, vi } from 'vitest';
import { type AgentsDeps, runAgents } from '../commands/agents.js';
import { AGENT_REGISTRY } from '../lib/launch/registry/index.js';
import type { AgentSpec } from '../lib/launch/registry/types.js';

/** `align agents`: every registry agent, whether it is installed, how Align connects, how to install. */
const FAKE: AgentSpec = {
  name: 'codex',
  label: 'Zephyr Test Agent',
  bin: 'zephyr-agent',
  injection: 'written-once',
  supported: true,
  install: { kind: 'docs', url: 'https://zephyr.example/install' },
};

function harness(over: Partial<AgentsDeps> & { onPath?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const onPath = over.onPath ?? ['claude'];
  const d: AgentsDeps = {
    specs: AGENT_REGISTRY,
    findOnPath: vi.fn((bin: string) => (onPath.includes(bin) ? `/usr/bin/${bin}` : null)),
    env: {},
    platform: 'linux',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { d, out, err };
}

describe('align agents: the table', () => {
  it('prints a header and one row per registry agent to stdout, nothing to stderr', () => {
    const h = harness();
    expect(runAgents({}, h.d)).toBe(0);
    expect(h.err).toEqual([]);
    const text = h.out.join('\n');
    expect(h.out[0]).toMatch(/^Agent\s+Installed\s+How Align connects\s+Install command/);
    for (const s of AGENT_REGISTRY) expect(text).toContain(s.label);
  });
  it('marks installed yes/no from the PATH scan (two examples each side)', () => {
    const h = harness({ onPath: ['claude', 'codex'] });
    runAgents({}, h.d);
    const row = (label: string) => h.out.find((l) => l.startsWith(`${label} `))!;
    expect(row('Claude Code')).toMatch(/^Claude Code\s+yes\s/);
    expect(row('Codex')).toMatch(/^Codex\s+yes\s/);
    expect(row('Cursor')).toMatch(/^Cursor\s+no\s/);
    expect(row('pi')).toMatch(/^pi\s+no\s/);
  });
  it('says how Align connects from the injection field, and the install text (both kinds)', () => {
    const h = harness();
    runAgents({}, h.d);
    const row = (label: string) => h.out.find((l) => l.startsWith(`${label} `))!;
    expect(row('Codex')).toContain('per session');
    expect(row('Codex')).toContain('npm i -g @openai/codex');
    expect(row('Cursor')).toContain('written once');
    expect(row('Cursor')).toContain('https://cursor.com/cli');
  });
  it('a spec added to the registry appears with no other change', () => {
    const h = harness({ specs: [...AGENT_REGISTRY, FAKE] });
    runAgents({}, h.d);
    const row = h.out.find((l) => l.startsWith('Zephyr Test Agent'))!;
    expect(row).toMatch(/Zephyr Test Agent\s+no\s+written once\s+https:\/\/zephyr\.example\/install/);
  });
  it('never spawns anything: the only probe is the PATH scan, once per agent', () => {
    const h = harness();
    runAgents({}, h.d);
    expect(h.d.findOnPath).toHaveBeenCalledTimes(AGENT_REGISTRY.length);
  });
});

describe('align agents --json', () => {
  it('prints one JSON array to stdout, one entry per registry agent, with the derived fields', () => {
    const h = harness({ onPath: ['codex'], specs: [...AGENT_REGISTRY, FAKE] });
    expect(runAgents({ json: true }, h.d)).toBe(0);
    expect(h.err).toEqual([]);
    const parsed = JSON.parse(h.out.join('\n')) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(AGENT_REGISTRY.length + 1);
    expect(parsed.find((a) => a['label'] === 'Codex')).toEqual({
      id: 'codex', label: 'Codex', bin: 'codex', installed: true, path: '/usr/bin/codex', supported: true,
      connects: 'per-session', graph: true, install: { kind: 'npm', argv: ['npm', 'i', '-g', '@openai/codex'] }, installCommand: 'npm i -g @openai/codex',
    });
    expect(parsed.find((a) => a['label'] === 'Zephyr Test Agent')).toMatchObject({
      installed: false, path: null, connects: 'written-once', install: { kind: 'docs', url: 'https://zephyr.example/install' }, installCommand: 'https://zephyr.example/install',
    });
  });
});
