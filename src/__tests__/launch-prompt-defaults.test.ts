import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH_AGENTS } from '../lib/launch/agents.js';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import { PICK_CANCELLED, pickAgent } from '../lib/launch/pick-agent.js';

/**
 * The REAL clack wiring behind the picker and the install question, for both callers: bare
 * `align` (launch.ts defaultDeps) and the first-run wizard (pick-agent.ts defaults). Decision 4
 * says default No, and only an explicit yes installs; Ctrl-C at the question leaves the picker.
 */
const clack = vi.hoisted(() => ({ CANCEL: Symbol('clack:cancel'), select: vi.fn(), confirm: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  select: clack.select,
  confirm: clack.confirm,
  isCancel: (v: unknown) => v === clack.CANCEL,
}));
// Never touch the real ~/.config/align-cli from this file.
vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({ getAgent: () => undefined, setAgent: () => undefined, getEnvironment: () => ({}) }),
}));

const NPM = '/usr/bin/npm';

function launchDeps(onPath: Record<string, string>, spawnInstall = vi.fn()): Partial<LaunchDeps> {
  // Everything except `pick` and `confirm`: those are the defaults under test.
  return {
    env: {}, argv: ['node', 'align'], cwd: '/proj', home: '/home/u', platform: 'linux', isTTY: true,
    config: { getAgent: () => undefined, setAgent: vi.fn() },
    findOnPath: (bin) => onPath[bin] ?? null,
    readCodexState: () => ({ present: false, overridden: [] }),
    readProjectState: () => ({ projectHasPreHook: false, projectHasPostHook: false, projectHasMcp: false, projectHasBlock: false }),
    cacheDir: () => '/cache', writeIfChanged: () => true, pruneLaunchFiles: vi.fn(), applyConfigWrite: vi.fn(),
    runAgent: vi.fn().mockResolvedValue(0), record: vi.fn(), err: () => {}, now: () => 0,
    spawnInstall,
  };
}

function wizard(onPath: string[], spawn = vi.fn()) {
  const config = { getAgent: () => undefined as string | undefined, setAgent: vi.fn() };
  const run = () => pickAgent(config, { interactive: true }, {
    env: {}, platform: 'linux', agents: LAUNCH_AGENTS,
    findOnPath: (bin) => (onPath.includes(bin) ? `/usr/bin/${bin}` : null),
    say: () => {}, spawn,
  });
  return { run, spawn, config };
}

beforeEach(() => {
  clack.select.mockReset();
  clack.confirm.mockReset();
});

describe('bare `align` (launch.ts defaults)', () => {
  it('asks the install question with No preselected', async () => {
    clack.select.mockResolvedValueOnce('codex').mockResolvedValueOnce(clack.CANCEL);
    clack.confirm.mockResolvedValueOnce(false);
    await launchIfChosen(launchDeps({ npm: NPM, claude: '/usr/bin/claude' }));
    expect(clack.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Install Codex now? (runs: npm i -g @openai/codex)', initialValue: false }));
  });
  it('Ctrl-C at the question exits (code 1) without installing or reopening the picker', async () => {
    const spawnInstall = vi.fn();
    clack.select.mockResolvedValueOnce('codex');
    clack.confirm.mockResolvedValueOnce(clack.CANCEL);
    expect(await launchIfChosen(launchDeps({ npm: NPM, claude: '/usr/bin/claude' }, spawnInstall))).toEqual({ handled: true, code: 1 });
    expect(spawnInstall).not.toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalledTimes(1);
  });
  it('only `true` installs: a truthy non-true answer is a No and goes back to the picker', async () => {
    const spawnInstall = vi.fn();
    clack.select.mockResolvedValueOnce('codex').mockResolvedValueOnce(clack.CANCEL);
    clack.confirm.mockResolvedValueOnce('yes');
    await launchIfChosen(launchDeps({ npm: NPM, claude: '/usr/bin/claude' }, spawnInstall));
    expect(spawnInstall).not.toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalledTimes(2);
  });
  it('the picker preselects the one installed agent and draws on stderr', async () => {
    clack.select.mockResolvedValueOnce(clack.CANCEL);
    await launchIfChosen(launchDeps({ claude: '/usr/bin/claude' }));
    expect(clack.select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ initialValue: 'claude-code', output: process.stderr }));
  });
});

describe('the first-run wizard (pick-agent.ts defaults)', () => {
  it('asks the install question with No preselected', async () => {
    const w = wizard(['npm', 'claude']);
    clack.select.mockResolvedValueOnce('codex').mockResolvedValueOnce(clack.CANCEL);
    clack.confirm.mockResolvedValueOnce(false);
    await w.run();
    expect(clack.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ initialValue: false }));
  });
  it('Ctrl-C at the question cancels the wizard without installing or reopening the picker', async () => {
    const w = wizard(['npm', 'claude']);
    clack.select.mockResolvedValueOnce('codex');
    clack.confirm.mockResolvedValueOnce(clack.CANCEL);
    expect(await w.run()).toBe(PICK_CANCELLED);
    expect(w.spawn).not.toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalledTimes(1);
  });
  it('only `true` installs: a truthy non-true answer is a No and goes back to the picker', async () => {
    const w = wizard(['npm', 'claude']);
    clack.select.mockResolvedValueOnce('codex').mockResolvedValueOnce(clack.CANCEL);
    clack.confirm.mockResolvedValueOnce('yes');
    expect(await w.run()).toBe(PICK_CANCELLED);
    expect(w.spawn).not.toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalledTimes(2);
  });
  it('the picker preselects the one installed agent, so Enter keeps it', async () => {
    const w = wizard(['opencode']);
    clack.select.mockResolvedValueOnce('opencode');
    expect(await w.run()).toBe('opencode');
    expect(clack.select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ initialValue: 'opencode' }));
  });
});
