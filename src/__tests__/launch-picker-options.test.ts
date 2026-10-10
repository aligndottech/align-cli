import { describe, expect, it, vi } from 'vitest';
import { LAUNCH_AGENTS, type LaunchAgent } from '../lib/launch/agents.js';
import { chooseAgent, pickerOptions } from '../lib/launch/picker-options.js';

/**
 * Phase P: the picker lists every agent Align supports. Installed ones first, by label; the
 * rest after them, by label, each with how to install it.
 */
const agent = (name: string): LaunchAgent => LAUNCH_AGENTS.find((a) => a.name === name)!;
const installedSet = (...bins: string[]) => (a: LaunchAgent) => bins.includes(a.bin);

describe('pickerOptions: order', () => {
  it('puts the installed agents first, sorted by label, then every other agent sorted by label', () => {
    const opts = pickerOptions(LAUNCH_AGENTS, installedSet('opencode', 'claude'));
    expect(opts.map((o) => o.value)).toEqual(['claude-code', 'opencode', 'aider', 'amp', 'auggie', 'cline', 'codex', 'continue', 'cursor', 'droid', 'gemini-cli', 'copilot', 'goose', 'grok-build', 'kiro', 'qwen', 'pi']);
  });
  it('a different installed set reorders (two examples): pi and Codex installed come first', () => {
    const opts = pickerOptions(LAUNCH_AGENTS, installedSet('pi', 'codex'));
    expect(opts.map((o) => o.value)).toEqual(['codex', 'pi', 'aider', 'amp', 'auggie', 'claude-code', 'cline', 'continue', 'cursor', 'droid', 'gemini-cli', 'copilot', 'goose', 'grok-build', 'kiro', 'opencode', 'qwen']);
  });
  it('lists every agent it is given, so a new registry spec appears without editing the picker', () => {
    const fake: LaunchAgent = { name: 'codex', label: 'Aardvark Agent', bin: 'aardvark', injection: 'per-session', supported: true, install: 'npm i -g aardvark' };
    const opts = pickerOptions([...LAUNCH_AGENTS, fake], installedSet());
    expect(opts.map((o) => o.label)).toContain('Aardvark Agent (not installed)');
    expect(opts).toHaveLength(LAUNCH_AGENTS.length + 1);
  });
});

describe('pickerOptions: the not-installed marker', () => {
  // clack's select draws `hint` on the ACTIVE row only, so the marker must be in the label to be
  // seen on every row; the hint carries the install command for the row the cursor is on.
  it('a not-installed agent is marked in its LABEL, with its install text as the hint (npm and a docs URL)', () => {
    const opts = pickerOptions(LAUNCH_AGENTS, installedSet('claude'));
    expect(opts.find((o) => o.value === 'codex')).toEqual({ value: 'codex', label: 'Codex (not installed)', hint: 'install: npm i -g @openai/codex' });
    expect(opts.find((o) => o.value === 'cursor')).toEqual({ value: 'cursor', label: 'Cursor (not installed)', hint: 'install: https://cursor.com/cli' });
  });
  it('an installed agent has its plain label and no hint (two examples)', () => {
    const opts = pickerOptions(LAUNCH_AGENTS, installedSet('claude', 'cursor-agent'));
    expect(opts.find((o) => o.value === 'claude-code')).toEqual({ value: 'claude-code', label: 'Claude Code' });
    expect(opts.find((o) => o.value === 'cursor')).toEqual({ value: 'cursor', label: 'Cursor' });
  });
});

describe('chooseAgent: the loop behind the picker', () => {
  const deps = (over: Partial<Parameters<typeof chooseAgent>[1]> = {}) => ({
    isInstalled: installedSet('claude'),
    select: vi.fn(),
    offer: vi.fn(),
    say: vi.fn(),
    ...over,
  });

  it('selecting an installed agent returns it and offers no install', async () => {
    const d = deps();
    d.select.mockResolvedValueOnce('claude-code');
    expect((await chooseAgent(LAUNCH_AGENTS, d))?.name).toBe('claude-code');
    expect(d.offer).not.toHaveBeenCalled();
  });
  it('cancelling the picker returns null', async () => {
    const d = deps();
    d.select.mockResolvedValueOnce(null);
    expect(await chooseAgent(LAUNCH_AGENTS, d)).toBeNull();
  });
  it('a not-installed pick that installs and is then found proceeds with it', async () => {
    let installed = ['claude'];
    const d = deps({ isInstalled: (a: LaunchAgent) => installed.includes(a.bin) });
    d.select.mockResolvedValueOnce('codex');
    d.offer.mockImplementationOnce(async () => { installed = ['claude', 'codex']; return 'installed'; });
    expect((await chooseAgent(LAUNCH_AGENTS, d))?.name).toBe('codex');
    expect(d.offer).toHaveBeenCalledExactlyOnceWith(agent('codex'));
  });
  it('an install that reports success but still is not on PATH says so and returns to the picker', async () => {
    const d = deps();
    d.select.mockResolvedValueOnce('codex').mockResolvedValueOnce('claude-code');
    d.offer.mockResolvedValueOnce('installed');
    expect((await chooseAgent(LAUNCH_AGENTS, d))?.name).toBe('claude-code');
    expect(d.select).toHaveBeenCalledTimes(2);
    expect(d.say.mock.calls.flat().join('\n')).toMatch(/codex.*still not on your PATH/i);
  });
  it('a declined or print-only install returns to the picker (two examples)', async () => {
    for (const outcome of ['declined', 'manual'] as const) {
      const d = deps();
      d.select.mockResolvedValueOnce('cursor').mockResolvedValueOnce(null);
      d.offer.mockResolvedValueOnce(outcome);
      expect(await chooseAgent(LAUNCH_AGENTS, d)).toBeNull();
      expect(d.select).toHaveBeenCalledTimes(2);
    }
  });
  it('with exactly one agent installed, that agent is preselected so Enter keeps it (two examples)', async () => {
    for (const bin of ['claude', 'opencode']) {
      const d = deps({ isInstalled: installedSet(bin) });
      d.select.mockResolvedValueOnce(null);
      await chooseAgent(LAUNCH_AGENTS, d);
      expect(d.select.mock.calls[0]![1]).toBe(LAUNCH_AGENTS.find((a) => a.bin === bin)!.name);
    }
  });
  it('with none or several installed, nothing is preselected', async () => {
    for (const bins of [[], ['claude', 'opencode']]) {
      const d = deps({ isInstalled: installedSet(...bins) });
      d.select.mockResolvedValueOnce(null);
      await chooseAgent(LAUNCH_AGENTS, d);
      expect(d.select.mock.calls[0]![1]).toBeUndefined();
    }
  });
  it('Ctrl-C at the install confirm leaves the picker as a cancel; a plain No returns to it', async () => {
    const cancelled = deps();
    cancelled.select.mockResolvedValueOnce('codex').mockResolvedValueOnce('claude-code');
    cancelled.offer.mockResolvedValueOnce('cancelled');
    expect(await chooseAgent(LAUNCH_AGENTS, cancelled)).toBeNull();
    expect(cancelled.select).toHaveBeenCalledTimes(1);
    const no = deps();
    no.select.mockResolvedValueOnce('codex').mockResolvedValueOnce('claude-code');
    no.offer.mockResolvedValueOnce('declined');
    expect((await chooseAgent(LAUNCH_AGENTS, no))?.name).toBe('claude-code');
    expect(no.select).toHaveBeenCalledTimes(2);
  });
});
