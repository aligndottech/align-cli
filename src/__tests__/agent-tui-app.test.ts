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
  return { term, press: (d: string) => onInput(d), screen: () => plain(out.join('')) };
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

  it('does not ask again for the same command prefix after s (yes for this session)', async () => {
    const { t, engine } = await launch();
    const first = engine.broker(cmdAsk('npm test'));
    await tick();
    expect(t.screen()).toContain('[y] yes   [s] yes for this session   [n] no');
    t.press('s');
    expect((await first).allow).toBe(true);
    const second = await Promise.race([engine.broker(cmdAsk('npm test -- --watch')), tick(200).then(() => 'asked' as const)]);
    expect(second).toEqual({ allow: true });
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
