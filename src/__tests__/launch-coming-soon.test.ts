import { describe, expect, it, vi } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import type * as Registry from '../lib/launch/registry/index.js';

/*
 * The "coming soon" branch: an agent the registry lists but cannot launch yet. Since wave A
 * every listed agent launches, so the registry is mocked with one planned entry to keep the
 * branch tested for the waves that add planned agents first (moved here from launch-default
 * and use-command, which used Codex for it).
 */
vi.mock('../lib/launch/registry/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof Registry>();
  const planned = { name: 'planned', label: 'Planned Agent', bin: 'planned', injection: 'per-session', supported: false, install: 'npm i -g planned' };
  const AGENT_REGISTRY = [...real.AGENT_REGISTRY, planned];
  return { AGENT_REGISTRY, specByName: (n: string | undefined) => AGENT_REGISTRY.find((a) => a.name === n) };
});

describe('an agent the registry lists but cannot launch yet', () => {
  it('bare `align` falls back to the card with one stderr line, and spawns nothing', async () => {
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runAgent = vi.fn();
    const deps = {
      env: {}, argv: ['node', 'align'], cwd: '/proj', home: '/home/u', platform: 'linux', isTTY: true,
      config: { getAgent: () => 'planned', setAgent: vi.fn() },
      findOnPath: (b: string) => `/usr/bin/${b}`,
      runAgent, record: vi.fn(), pick: vi.fn(), confirm: vi.fn(async () => false), spawnInstall: vi.fn(), err: (l: string) => err.push(l), now: () => 1,
    } as unknown as Partial<LaunchDeps>;
    expect(await launchIfChosen(deps)).toEqual({ handled: false });
    expect(err).toEqual(['Planned Agent launching is coming soon; showing your graph instead. Switch with `align use`.']);
    expect(runAgent).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('`align use` reports it as coming soon and stores nothing', async () => {
    const err: string[] = [];
    const setAgent = vi.fn();
    const deps: UseDeps = {
      config: { getAgent: () => 'claude-code', setAgent, clearAgent: vi.fn(), setLaunchOff: vi.fn(), clearRefusedWrites: vi.fn() },
      writtenConfigs: { get: () => ({}), drop: () => {} },
      findOnPath: (b) => `/b/${b}`, env: {}, platform: 'linux', log: () => {}, err: (l) => err.push(l),
    };
    expect(await runUse('planned', deps)).toBe(1);
    expect(setAgent).not.toHaveBeenCalled();
    expect(err.join('\n')).toMatch(/coming soon/);
  });
});
