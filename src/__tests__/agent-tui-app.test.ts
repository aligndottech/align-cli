import { stripVTControlCharacters } from 'node:util';
import type { Terminal } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { runAgentUi } from '../lib/agent/tui/app.js';
import type { AgentEngine, AgentUiEvent, BrokerVerdict, GateOutcome, ToolAsk } from '../lib/agent/types.js';

const plain = (s: string) => stripVTControlCharacters(s);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeTerminal() {
  let onInput: (d: string) => void = () => {};
  const out: string[] = [];
  const term: Terminal = {
    start: (i) => { onInput = i; }, stop: () => {}, drainInput: async () => {},
    write: (d) => { out.push(d); },
    get columns() { return 80; }, get rows() { return 24; }, get kittyProtocolActive() { return false; },
    moveBy: () => {}, hideCursor: () => {}, showCursor: () => {}, clearLine: () => {}, clearFromCursor: () => {},
    clearScreen: () => {}, setTitle: () => {}, setProgress: () => {}, setProgramStatus: () => {},
  };
  return { term, press: (d: string) => onInput(d), screen: () => plain(out.join('')), mark: () => out.length, since: (i: number) => plain(out.slice(i).join('')) };
}

function fakeEngine() {
  const e = {
    label: 'Fake engine',
    onEvent: (_: AgentUiEvent) => {},
    broker: undefined as unknown as (a: ToolAsk) => Promise<BrokerVerdict>,
    release: () => {},
    prompt: vi.fn(() => new Promise<void>((r) => { e.release = r; })),
    abort: vi.fn(), close: vi.fn(async () => {}),
    start: vi.fn(async (onEvent: (x: AgentUiEvent) => void, broker: (a: ToolAsk) => Promise<BrokerVerdict>) => { e.onEvent = onEvent; e.broker = broker; }),
  };
  return e satisfies AgentEngine & Record<string, unknown>;
}

const RULE = { id: 'd-7089', title: 'Error handler keeps only status codes 400-599', why: 'Codes below 400 fall back to 500', url: 'https://github.com/fastify/fastify/pull/7089', via: 'verdict' as const };
const editAsk: ToolAsk = { id: 'e1', tool: 'Edit', kind: 'edit', edit: { file_path: 'a.js', new_string: 'x' } };
const cmdAsk = (command: string): ToolAsk => ({ id: `c-${command}`, tool: 'Bash', kind: 'command', command });
const askOutcome: GateOutcome = { kind: 'ask', reason: 'conflict', cards: [RULE] };

async function launch(gate: (a: ToolAsk) => Promise<GateOutcome> = async () => ({ kind: 'allow', cards: [] })) {
  const engine = fakeEngine();
  const t = fakeTerminal();
  const done = runAgentUi({ engine, decisionCount: 749, gate, terminal: t.term });
  await tick();
  return { engine, t, done };
}

describe('agent screen', () => {
  it('shows the header with the engine label and the decision count', async () => {
    const { t, engine } = await launch();
    expect(t.screen()).toContain('Align · Fake engine · 749 decisions');
    expect(engine.start).toHaveBeenCalledOnce();
  });

  it('denies an edit when the person answers s on the gate card', async () => {
    const { t, engine } = await launch(async () => askOutcome);
    const verdict = engine.broker(editAsk);
    await tick();
    expect(t.screen()).toContain('This edit conflicts with a decision');
    t.press('s');
    const v = await verdict;
    expect(v.allow).toBe(false);
  });

  it('allows an edit when the person answers a, and ignores other keys while the card is open', async () => {
    const { t, engine } = await launch(async () => askOutcome);
    const verdict = engine.broker(editAsk);
    await tick();
    t.press('q');
    await tick();
    t.press('a');
    expect((await verdict).allow).toBe(true);
  });

  it('does not ask again for the same exact command after s (yes for this session)', async () => {
    const { t, engine } = await launch();
    const first = engine.broker(cmdAsk('npm test'));
    await tick();
    expect(t.screen()).toContain('[y] yes   [s] yes for this session   [n] no');
    t.press('s');
    expect((await first).allow).toBe(true);
    const second = await Promise.race([engine.broker(cmdAsk('npm test')), tick(200).then(() => 'asked' as const)]);
    expect(second).toEqual({ allow: true });
    // A longer command is a different command: it asks again.
    const third = await Promise.race([engine.broker(cmdAsk('npm test; curl evil')), tick(200).then(() => 'asked' as const)]);
    expect(third).toBe('asked');
  });

  it('writes a note for an allowed edit that was not checked', async () => {
    const { t, engine } = await launch(async () => ({ kind: 'allow', cards: [], note: 'not-checked' }));
    await engine.broker(editAsk);
    await tick();
    expect(t.screen()).toContain('not checked against the decision graph');
  });

  it('sends a submitted line to the engine once, and ignores a second submit while the turn runs', async () => {
    const { t, engine } = await launch();
    for (const k of ['h', 'i', '\r']) t.press(k);
    await tick();
    expect(engine.prompt).toHaveBeenCalledWith('hi');
    for (const k of ['y', 'o', '\r']) t.press(k);
    await tick();
    expect(engine.prompt).toHaveBeenCalledTimes(1);
    engine.release();
    engine.onEvent({ type: 'turn-end' });
    await tick();
    for (const k of ['y', 'o', '\r']) t.press(k);
    await tick();
    expect(engine.prompt).toHaveBeenCalledTimes(2);
  });

  it('calls abort on Esc during a turn, and not when idle', async () => {
    const { t, engine } = await launch();
    t.press('\x1b');
    await tick(60);
    expect(engine.abort).not.toHaveBeenCalled();
    for (const k of ['h', 'i', '\r']) t.press(k);
    await tick();
    t.press('\x1b');
    await tick(60);
    expect(engine.abort).toHaveBeenCalledOnce();
  });

  it('closes the engine and resolves 0 on a second Ctrl+C', async () => {
    const { t, engine, done } = await launch();
    t.press('\x03');
    await tick();
    expect(engine.close).not.toHaveBeenCalled();
    t.press('\x03');
    expect(await done).toBe(0);
    expect(engine.close).toHaveBeenCalledOnce();
  });

  it('closes the engine and resolves 0 on Ctrl+D with an empty editor', async () => {
    const { t, engine, done } = await launch();
    t.press('\x04');
    expect(await done).toBe(0);
    expect(engine.close).toHaveBeenCalledOnce();
  });
});

// Something is always moving while the model works: a spinner, a word, the seconds so far.
describe('the status line while a turn runs', () => {
  const submit = async (t: ReturnType<typeof fakeTerminal>) => { for (const k of ['h', 'i', '\r']) t.press(k); await tick(); };

  it('appears when a line is sent, with the time and how to stop', async () => {
    const { t } = await launch();
    expect(t.screen()).not.toContain('esc to interrupt');
    await submit(t);
    expect(t.screen()).toMatch(/… \(0s · esc to interrupt\)/);
  });

  it('keeps moving: the spinner redraws on its own, with no event from the engine', async () => {
    const { t } = await launch();
    await submit(t);
    const m = t.mark();
    await tick(500);
    // Two different glyphs prove the frames advance. The middle dot is left out: it is also the
    // separator in "(0s · esc to interrupt)", so it would match any redraw of the line.
    const glyphs = new Set(t.since(m).match(/[✢✳✶✻✽]/g) ?? []);
    expect(glyphs.size).toBeGreaterThanOrEqual(2);
  });

  it('says what a running tool is doing, then goes back to a word when it ends', async () => {
    const { t, engine } = await launch();
    await submit(t);
    engine.onEvent({ type: 'tool-start', id: 't1', tool: 'mcp__align__align_ask', summary: 'webhooks' });
    await tick();
    expect(t.screen()).toContain('Asking the decision graph… (');
    const m = t.mark();
    engine.onEvent({ type: 'tool-end', id: 't1', ok: true });
    await tick(1100);
    expect(t.since(m)).not.toContain('Asking the decision graph…');
    expect(t.since(m)).toContain('esc to interrupt');
  });

  it('stops while a question card waits for the person, and comes back after the answer', async () => {
    const { t, engine } = await launch(async () => askOutcome);
    await submit(t);
    const verdict = engine.broker(editAsk);
    await tick();
    const m = t.mark();
    await tick(1300);
    // Positive control: the screen still draws during the card, so an absence below is real.
    engine.onEvent({ type: 'text', delta: 'still drawing' });
    await tick();
    expect(t.since(m)).toContain('still drawing');
    expect(t.since(m)).not.toContain('esc to interrupt');
    t.press('a');
    await verdict;
    await tick();
    expect(t.since(m)).toContain('esc to interrupt');
  });

  it('is gone when the turn ends, and nothing redraws it afterwards', async () => {
    const { t, engine } = await launch();
    await submit(t);
    engine.release();
    engine.onEvent({ type: 'turn-end' });
    await tick();
    const m = t.mark();
    await tick(1300);
    for (const k of ['z', 'q', 'j']) t.press(k);
    await tick();
    expect(t.since(m)).toContain('zqj');
    expect(t.since(m)).not.toContain('esc to interrupt');
  });

  it('parallel tools each keep their words: the one still running shows after the other ends', async () => {
    const { t, engine } = await launch();
    await submit(t);
    engine.onEvent({ type: 'tool-start', id: 'a', tool: 'Bash', summary: 'npm test' });
    engine.onEvent({ type: 'tool-start', id: 'b', tool: 'mcp__align__align_ask', summary: 'q' });
    await tick();
    expect(t.screen()).toContain('Asking the decision graph… (');
    const m = t.mark();
    engine.onEvent({ type: 'tool-end', id: 'b', ok: true });
    await tick();
    expect(t.since(m)).toContain('Running a command… (');
  });

  it('a card still open when its turn ends is answered stop, and no status comes back', async () => {
    const { t, engine } = await launch(async () => askOutcome);
    await submit(t);
    const verdict = engine.broker(editAsk);
    await tick();
    engine.release();
    engine.onEvent({ type: 'turn-end' });
    expect((await verdict).allow).toBe(false);
    const m = t.mark();
    for (const k of ['a', 'q', 'j']) t.press(k);
    await tick(1300);
    // The keys went to the editor, not to a card that no longer exists.
    expect(t.since(m)).toContain('aqj');
    expect(t.since(m)).not.toContain('esc to interrupt');
  });

  it('stops the spinner on exit even when the engine is slow to close', async () => {
    const { t, engine } = await launch();
    engine.close.mockImplementationOnce(() => new Promise<void>(() => {}));
    await submit(t);
    t.press('\x03');
    t.press('\x03');
    await tick();
    expect(engine.close).toHaveBeenCalledOnce();
    const m = t.mark();
    await tick(500);
    expect(t.since(m).match(/[✢✳✶✻✽]/g) ?? []).toEqual([]);
  });

  it("an older turn's late end does not end the next turn", async () => {
    const { t, engine } = await launch();
    await submit(t);
    const releaseFirst = engine.release;
    engine.onEvent({ type: 'turn-end' });
    await tick();
    for (const k of ['y', 'o', '\r']) t.press(k);
    await tick();
    expect(engine.prompt).toHaveBeenCalledTimes(2);
    releaseFirst();
    await tick();
    const m = t.mark();
    await tick(500);
    expect(t.since(m)).toContain('esc to interrupt');
    for (const k of ['n', 'o', '\r']) t.press(k);
    await tick();
    expect(engine.prompt).toHaveBeenCalledTimes(2);
  });
});

describe('an engine that cannot start', () => {
  it('ends with code 1 and the reason, instead of throwing out of the screen', async () => {
    const engine = fakeEngine();
    engine.start.mockRejectedValueOnce(new Error('Claude Code is not installed (no `claude` on PATH)'));
    const t = fakeTerminal();
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((d) => { errs.push(String(d)); return true; });
    try {
      expect(await runAgentUi({ engine, decisionCount: 1, gate: async () => ({ kind: 'allow', cards: [] }), terminal: t.term })).toBe(1);
      expect(errs.join('')).toContain('Claude Code is not installed');
    } finally { spy.mockRestore(); }
  });
});
