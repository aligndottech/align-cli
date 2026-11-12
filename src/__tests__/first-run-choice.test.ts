import { describe, expect, it, vi } from 'vitest';
import { choiceCopy, type ChoiceDeps, resolveRunChoice, type RunMode, type Suggestion, suggestRunMode } from '../lib/first-run-choice.js';

const onPath = (...bins: string[]) => (bin: string) => (bins.includes(bin) ? `/usr/bin/${bin}` : null);
const suggest = (...bins: string[]) => suggestRunMode(onPath(...bins), {}, 'linux');

describe('suggestRunMode (detect, then suggest)', () => {
  it('names Claude Code when only Claude Code is installed', () => {
    const s = suggest('claude');
    expect(s.mode).toBe('keep');
    expect(s.keep.map((a) => a.label)).toEqual(['Claude Code']);
  });
  it('names Codex when only Codex is installed', () => {
    const s = suggest('codex');
    expect(s.mode).toBe('keep');
    expect(s.keep.map((a) => a.name)).toEqual(['codex']);
  });
  it('names Cursor when only Cursor is installed', () => {
    const s = suggest('cursor-agent');
    expect(s.mode).toBe('keep');
    expect(s.keep.map((a) => a.name)).toEqual(['cursor']);
  });
  it('takes Claude Code, then Codex, then Cursor when several are installed, and lists the rest', () => {
    expect(suggest('cursor-agent', 'codex', 'claude').keep.map((a) => a.name)).toEqual(['claude-code', 'codex', 'cursor']);
    expect(suggest('cursor-agent', 'codex').keep.map((a) => a.name)).toEqual(['codex', 'cursor']);
  });
  it('suggests Align\'s own agent when none of the three is installed', () => {
    const s = suggest('aider', 'goose');
    expect(s.mode).toBe('own');
    expect(s.keep).toEqual([]);
  });
});

describe('choiceCopy', () => {
  it('names the detected agent and the way back', () => {
    const c = choiceCopy(suggest('claude'));
    expect(c.message).toBe('Align found Claude Code on this machine. How do you want to use Align?');
    expect(c.keepLabel).toBe('1. Keep Claude Code. Align checks each edit and answers questions inside it.');
    expect(c.ownLabel).toBe("2. Use Align's own coding agent.");
    expect(c.footer).toBe('Change this later: align --switch');
  });
  it('lists the other agents it found', () => {
    expect(choiceCopy(suggest('claude', 'codex', 'cursor-agent')).message).toBe(
      'Align found Claude Code on this machine, and also Codex, Cursor. How do you want to use Align?',
    );
  });
  it('does not name an agent when none was found', () => {
    const c = choiceCopy(suggest());
    expect(c.message).toBe('How do you want to use Align?');
    expect(c.keepLabel).toContain('1. Keep your existing agent');
  });
});

function deps(over: Partial<ChoiceDeps> = {}): ChoiceDeps & { stored: { v: RunMode | undefined }; lines: string[] } {
  const stored: { v: RunMode | undefined } = { v: undefined };
  const lines: string[] = [];
  return {
    tty: true,
    switching: false,
    suggestion: suggest('claude') as Suggestion,
    getStored: () => stored.v,
    setStored: (m) => { stored.v = m; },
    ask: vi.fn().mockResolvedValue('keep'),
    wire: vi.fn().mockResolvedValue(true),
    say: (l) => lines.push(l),
    stored,
    lines,
    ...over,
  };
}

describe('resolveRunChoice', () => {
  it('choosing 1 wires the existing agent, opens nothing of Align\'s, and stores the answer', async () => {
    const d = deps();
    expect(await resolveRunChoice(d)).toEqual({ action: 'keep', wired: true });
    expect(d.wire).toHaveBeenCalledTimes(1);
    expect(d.stored.v).toBe('keep');
    expect(d.lines.join('\n')).toContain('Open Claude Code');
  });
  it('choosing 2 opens Align\'s own agent, wires nothing, and stores the answer', async () => {
    const d = deps({ ask: vi.fn().mockResolvedValue('own') });
    expect(await resolveRunChoice(d)).toEqual({ action: 'own' });
    expect(d.wire).not.toHaveBeenCalled();
    expect(d.stored.v).toBe('own');
  });
  it('asks with the detected suggestion', async () => {
    const d = deps();
    await resolveRunChoice(d);
    expect(d.ask).toHaveBeenCalledWith(d.suggestion);
  });
  it('does not ask on the second run, and follows the stored answer', async () => {
    const d = deps();
    await resolveRunChoice(d);
    d.wire = vi.fn();
    (d.ask as ReturnType<typeof vi.fn>).mockClear();
    expect(await resolveRunChoice(d)).toEqual({ action: 'keep', wired: false });
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.wire).not.toHaveBeenCalled();
  });
  it('follows a stored "own" without asking', async () => {
    const d = deps();
    d.stored.v = 'own';
    expect(await resolveRunChoice(d)).toEqual({ action: 'own' });
    expect(d.ask).not.toHaveBeenCalled();
  });
  it('--switch asks again even with a stored answer, and replaces it', async () => {
    const d = deps({ switching: true, ask: vi.fn().mockResolvedValue('own') });
    d.stored.v = 'keep';
    expect(await resolveRunChoice(d)).toEqual({ action: 'own' });
    expect(d.ask).toHaveBeenCalledTimes(1);
    expect(d.stored.v).toBe('own');
  });
  it('without a terminal takes the suggestion, never asks, and stores nothing', async () => {
    const d = deps({ tty: false });
    expect(await resolveRunChoice(d)).toEqual({ action: 'keep', wired: false });
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.wire).not.toHaveBeenCalled();
    expect(d.stored.v).toBeUndefined();
    expect(d.lines.join('\n')).toContain('Run align in a terminal');
  });
  it('without a terminal and no agent found, takes Align\'s own agent quietly', async () => {
    const d = deps({ tty: false, suggestion: suggest() });
    expect(await resolveRunChoice(d)).toEqual({ action: 'own' });
    expect(d.lines).toEqual([]);
  });
  it('Ctrl-C leaves everything as it was', async () => {
    const d = deps({ ask: vi.fn().mockResolvedValue(null) });
    expect(await resolveRunChoice(d)).toEqual({ action: 'cancelled' });
    expect(d.stored.v).toBeUndefined();
  });
  it('a declined write is not remembered, so the question comes back', async () => {
    const d = deps({ wire: vi.fn().mockResolvedValue(false) });
    expect(await resolveRunChoice(d)).toEqual({ action: 'keep', wired: false });
    expect(d.stored.v).toBeUndefined();
  });
  it('the wizard path, already wired, does not wire twice', async () => {
    const d = deps({ alreadyWired: true });
    expect(await resolveRunChoice(d)).toEqual({ action: 'keep', wired: true });
    expect(d.wire).not.toHaveBeenCalled();
    expect(d.stored.v).toBe('keep');
  });
});
