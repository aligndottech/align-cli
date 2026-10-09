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
    expect(opts.map((o) => o.label)).toEqual(['Claude Code', 'OpenCode', 'Codex', 'Cursor', 'Gemini CLI', 'GitHub Copilot CLI', 'pi']);
  });
  it('a different installed set reorders (two examples): pi and Codex installed come first', () => {
    const opts = pickerOptions(LAUNCH_AGENTS, installedSet('pi', 'codex'));
    expect(opts.map((o) => o.value)).toEqual(['codex', 'pi', 'claude-code', 'cursor', 'gemini-cli', 'copilot', 'opencode']);
  });
  it('lists every agent it is given, so a new registry spec appears without editing the picker', () => {
    const fake: LaunchAgent = { name: 'codex', label: 'Aardvark Agent', bin: 'aardvark', injection: 'per-session', supported: true, install: 'npm i -g aardvark' };
    const opts = pickerOptions([...LAUNCH_AGENTS, fake], installedSet());
    expect(opts.map((o) => o.label)).toContain('Aardvark Agent');
    expect(opts).toHaveLength(LAUNCH_AGENTS.length + 1);
  });
});

describe('pickerOptions: hints', () => {
  it('a not-installed agent says so, with its install text (npm and a docs URL, both kinds)', () => {
    const opts = pickerOptions(LAUNCH_AGENTS, installedSet('claude'));
    expect(opts.find((o) => o.value === 'codex')!.hint).toBe('not installed: npm i -g @openai/codex');
    expect(opts.find((o) => o.value === 'cursor')!.hint).toBe('not installed: https://cursor.com/cli');
  });
  it('an installed agent carries no "not installed" hint (two examples)', () => {
    const opts = pickerOptions(LAUNCH_AGENTS, installedSet('claude', 'cursor-agent'));
    for (const id of ['claude-code', 'cursor']) expect(opts.find((o) => o.value === id)!.hint ?? '').not.toContain('not installed');
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
});
