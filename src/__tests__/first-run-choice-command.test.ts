import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The command end to end, over an in-memory config and a stubbed prompt: HOME-free, so nothing here can touch ~/.align.
const choices = vi.hoisted(() => ({} as Record<string, 'keep' | 'own'>));
vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({ getRunChoice: (r: string) => choices[r], setRunChoice: (r: string, m: 'keep' | 'own') => { choices[r] = m; } }),
}));
const select = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', () => ({ select, isCancel: (v: unknown) => v === Symbol.for('cancel'), log: { info: vi.fn() } }));
const confirmAgentWrites = vi.hoisted(() => vi.fn().mockResolvedValue({ confirmed: true, editors: [{ name: 'Claude Code' }] }));
const writeAgentAlignment = vi.hoisted(() => vi.fn().mockReturnValue(['.mcp.json']));
vi.mock('../commands/setup.js', () => ({ confirmAgentWrites, writeAgentAlignment }));
const connectDetectedAgents = vi.hoisted(() => vi.fn().mockResolvedValue({ detected: 1, connected: 1, wired: ['Claude Code'] }));
vi.mock('../commands/connect-agents.js', () => ({ connectDetectedAgents }));
const getRepoRoot = vi.hoisted(() => vi.fn());
vi.mock('../lib/run-choice-key.js', () => ({ runChoiceKey: getRepoRoot }));
const findOnPath = vi.hoisted(() => vi.fn());
vi.mock('../lib/launch/detect.js', () => ({ findOnPath }));

import { runFirstRunChoice } from '../commands/first-run-choice.js';

const inTty = process.stdin.isTTY;
const outTty = process.stdout.isTTY;
const tty = (on: boolean) => {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
};

describe('runFirstRunChoice', () => {
  beforeEach(() => {
    for (const k of Object.keys(choices)) delete choices[k];
    select.mockReset();
    // Reset with their values: restoreAllMocks below also clears a hoisted mock's implementation.
    getRepoRoot.mockReset().mockResolvedValue('/work/repo');
    confirmAgentWrites.mockReset().mockResolvedValue({ confirmed: true, editors: [{ name: 'Claude Code' }] });
    writeAgentAlignment.mockReset().mockReturnValue(['.mcp.json']);
    connectDetectedAgents.mockReset().mockResolvedValue({ detected: 1, connected: 1, wired: ['Claude Code'] });
    findOnPath.mockReset().mockImplementation((bin: string) => (bin === 'claude' ? '/usr/bin/claude' : null));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tty(true);
  });
  afterEach(() => {
    tty(Boolean(inTty));
    Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
    vi.restoreAllMocks();
  });

  it('preselects "keep" when Claude Code is installed, with the prompt text', async () => {
    select.mockResolvedValue('keep');
    await runFirstRunChoice();
    const arg = select.mock.calls[0]![0];
    expect(arg.message).toBe('Align found Claude Code on this machine. How do you want to use Align?');
    expect(arg.initialValue).toBe('keep');
    expect(arg.options.map((o: { label: string }) => o.label)).toEqual([
      '1. Keep Claude Code. Align checks each edit and answers questions inside it.',
      "2. Use Align's own coding agent.",
    ]);
  });
  it('preselects Align\'s own agent when none of the three is installed', async () => {
    findOnPath.mockReturnValue(null);
    select.mockResolvedValue('own');
    await runFirstRunChoice();
    expect(select.mock.calls[0]![0].initialValue).toBe('own');
  });
  it('"keep" runs setup\'s own wiring steps, stores the answer for this repo, and the second run does not ask', async () => {
    select.mockResolvedValue('keep');
    expect(await runFirstRunChoice()).toEqual({ action: 'keep', wired: true });
    expect(confirmAgentWrites).toHaveBeenCalledTimes(1);
    expect(writeAgentAlignment).toHaveBeenCalledWith('local');
    expect(connectDetectedAgents).toHaveBeenCalledWith('local', expect.objectContaining({ approved: true }));
    expect(choices['/work/repo']).toBe('keep');
    expect(await runFirstRunChoice()).toEqual({ action: 'keep', wired: false });
    expect(select).toHaveBeenCalledTimes(1);
  });
  it('"own" wires nothing and is remembered', async () => {
    select.mockResolvedValue('own');
    expect(await runFirstRunChoice()).toEqual({ action: 'own' });
    expect(confirmAgentWrites).not.toHaveBeenCalled();
    expect(choices['/work/repo']).toBe('own');
  });
  it('switching asks again and replaces the stored answer', async () => {
    choices['/work/repo'] = 'keep';
    select.mockResolvedValue('own');
    expect(await runFirstRunChoice({ switching: true })).toEqual({ action: 'own' });
    expect(choices['/work/repo']).toBe('own');
  });
  it('without a terminal it never prompts and never writes', async () => {
    tty(false);
    expect(await runFirstRunChoice()).toEqual({ action: 'keep', wired: false });
    expect(select).not.toHaveBeenCalled();
    expect(confirmAgentWrites).not.toHaveBeenCalled();
  });
});
