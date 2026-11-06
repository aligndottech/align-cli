import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeCodeEngine } from '../lib/agent/engines/claude-code.js';
import type { AgentUiEvent, BrokerVerdict, ToolAsk } from '../lib/agent/types.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => this.written.push(...String(d).split('\n').filter(Boolean)));
  }
  /** One stdout line from claude. */
  say(o: unknown) { this.stdout.write(`${JSON.stringify(o)}\n`); }
  lines() { return this.written.map((l) => JSON.parse(l) as Record<string, any>); }
}

const tick = () => new Promise((r) => setImmediate(r));
const allow = async (): Promise<BrokerVerdict> => ({ allow: true });

function setup(over: { broker?: (a: ToolAsk) => Promise<BrokerVerdict>; env?: Record<string, string | undefined>; firstEventTimeoutMs?: number; spawnEvent?: (c: FakeChild) => void } = {}) {
  const child = new FakeChild();
  const spawn = vi.fn(() => { setImmediate(() => (over.spawnEvent ?? ((c) => c.emit('spawn')))(child)); return child; });
  const engine = createClaudeCodeEngine({ cwd: '/work', env: over.env ?? { HOME: '/h' }, spawn: spawn as never, firstEventTimeoutMs: over.firstEventTimeoutMs });
  const events: AgentUiEvent[] = [];
  const started = engine.start((e) => events.push(e), over.broker ?? allow);
  return { child, spawn, engine, events, started };
}
const result = { type: 'result', subtype: 'success' };

afterEach(() => { vi.useRealTimers(); });

describe('conversation lines', () => {
  it('writes initialize first, then the user message', async () => {
    const { child, engine, started } = setup();
    await started;
    const p = engine.prompt('fix it');
    await tick();
    expect(child.lines()).toEqual([
      expect.objectContaining({ type: 'control_request', request: { subtype: 'initialize' } }),
      { type: 'user', message: { role: 'user', content: 'fix it' } },
    ]);
    child.say(result);
    await p;
  });
  it('a second prompt sends a second user line without initialising again', async () => {
    const { child, engine, started } = setup();
    await started;
    const p1 = engine.prompt('one'); await tick(); child.say(result); await p1;
    const p2 = engine.prompt('two'); await tick(); child.say(result); await p2;
    const types = child.lines().map((l) => l.request?.subtype ?? l.message.content);
    expect(types).toEqual(['initialize', 'one', 'two']);
  });
});

describe('permission requests', () => {
  const writeReq = { type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/a.ts', content: 'x' }, tool_use_id: 'tu1' } };
  it('a denial answers with deny, the broker message and the same request id', async () => {
    const broker = vi.fn(async () => ({ allow: false, message: 'conflicts with D-1' }) as BrokerVerdict);
    const { child, started } = setup({ broker });
    await started;
    child.say(writeReq);
    await tick(); await tick();
    expect(broker).toHaveBeenCalledWith({ id: 'tu1', tool: 'Write', kind: 'edit', edit: { file_path: '/a.ts', content: 'x' } });
    expect(child.lines().at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'deny', message: 'conflicts with D-1' } } });
  });
  it('an allow answers with the request input unchanged', async () => {
    const { child, started } = setup();
    await started;
    child.say({ ...writeReq, request_id: 'req-2' });
    await tick(); await tick();
    expect(child.lines().at(-1)?.response).toEqual({ subtype: 'success', request_id: 'req-2', response: { behavior: 'allow', updatedInput: { file_path: '/a.ts', content: 'x' } } });
  });
  it('a broker that throws becomes a deny, not a hung agent', async () => {
    const { child, started } = setup({ broker: async () => { throw new Error('boom'); } });
    await started;
    child.say(writeReq);
    await tick(); await tick();
    const r = child.lines().at(-1)?.response.response;
    expect(r.behavior).toBe('deny');
    expect(r.message).toContain('boom');
  });
});

describe('events', () => {
  it('turns text deltas into text events in order and the result into turn-end', async () => {
    const { child, engine, events, started } = setup();
    await started;
    const p = engine.prompt('hi');
    for (const t of ['a', 'b']) child.say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
    child.say(result);
    await p;
    expect(events).toEqual([{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }, { type: 'turn-end' }]);
  });
  it('handles a line split across chunks', async () => {
    const { child, engine, events, started } = setup();
    await started;
    const p = engine.prompt('hi');
    const s = JSON.stringify(result);
    child.stdout.write(s.slice(0, 5)); await tick();
    child.stdout.write(`${s.slice(5)}\n`);
    await p;
    expect(events).toEqual([{ type: 'turn-end' }]);
  });
});

describe('failures', () => {
  it('a child exit mid-turn emits an error event and rejects the prompt', async () => {
    const { child, engine, events, started } = setup();
    await started;
    const p = engine.prompt('hi');
    child.stderr.write('bad things\n'); await tick();
    child.emit('exit', 2, null);
    await expect(p).rejects.toThrow(/exited/);
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('exited') }]);
    expect((events[0] as { message: string }).message).toContain('bad things');
  });
  it('prompting after the child is gone rejects', async () => {
    const { child, engine, started } = setup();
    await started;
    child.emit('exit', 0, null);
    await expect(engine.prompt('hi')).rejects.toThrow(/exited/);
  });
  it('ENOENT on spawn says Claude Code is not installed, as an event and a rejection', async () => {
    const { events, started } = setup({ spawnEvent: (c) => c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })) });
    await expect(started).rejects.toThrow('Claude Code is not installed (no `claude` on PATH)');
    expect(events).toEqual([{ type: 'error', message: 'Claude Code is not installed (no `claude` on PATH)' }]);
  });
  it('another spawn error surfaces its own message', async () => {
    const { started } = setup({ spawnEvent: (c) => c.emit('error', Object.assign(new Error('EACCES nope'), { code: 'EACCES' })) });
    await expect(started).rejects.toThrow('EACCES nope');
  });
  it('no init line in time emits an error naming `claude --version`', async () => {
    const { events, started } = setup({ firstEventTimeoutMs: 20 });
    await started;
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('claude --version') }]);
  });
  it('an init line in time cancels the timeout', async () => {
    const { child, events, started } = setup({ firstEventTimeoutMs: 20 });
    await started;
    child.say({ type: 'system', subtype: 'init' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
  });
});

describe('spawn contract', () => {
  it('spawns claude in the cwd with the host-permission argv and no bypass', async () => {
    const { spawn, started } = setup();
    await started;
    const [bin, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(bin).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', '--permission-mode', 'manual']));
    expect(args.join(' ')).not.toContain('bypassPermissions');
    expect(opts.cwd).toBe('/work');
  });
  it('honours bin and extraArgs', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => { setImmediate(() => child.emit('spawn')); return child; });
    const e = createClaudeCodeEngine({ cwd: '/w', env: {}, bin: '/x/claude', extraArgs: ['--model', 'haiku'], spawn: spawn as never });
    await e.start(() => {}, allow);
    const [bin, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('/x/claude');
    expect(args.slice(-2)).toEqual(['--model', 'haiku']);
  });
  it('gives the child exactly the env it was handed, nothing from this process', async () => {
    const saved = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-saved-key-must-not-leak';
    try {
      const startup = { HOME: '/h', PATH: '/bin' };
      const { spawn, started } = setup({ env: startup });
      await started;
      const opts = (spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string | undefined> }])[2];
      expect(opts.env).toEqual(startup);
      expect(opts.env['ANTHROPIC_API_KEY']).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });
});

describe('abort', () => {
  it('sends an interrupt control request and the turn ends on the result claude answers with', async () => {
    const { child, engine, events, started } = setup();
    await started;
    const p = engine.prompt('long job');
    await tick();
    engine.abort();
    await tick();
    expect(child.lines().at(-1)).toEqual({ type: 'control_request', request_id: expect.any(String), request: { subtype: 'interrupt' } });
    child.say({ type: 'result', subtype: 'error_during_execution' });
    await p;
    expect(events).toEqual([{ type: 'turn-end' }]);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('uses a fresh request id each time', async () => {
    const { child, engine, started } = setup();
    await started;
    engine.abort(); engine.abort();
    await tick();
    const ids = child.lines().filter((l) => l.request?.subtype === 'interrupt').map((l) => l.request_id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('close', () => {
  it('ends stdin and resolves when the child exits, without killing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { child, engine, started } = setup();
    await vi.advanceTimersByTimeAsync(5); // let the spawn event land under fake timers is not needed for setImmediate
    await started;
    const endSpy = vi.spyOn(child.stdin, 'end');
    const c = engine.close();
    expect(endSpy).toHaveBeenCalled();
    child.emit('exit', 0, null);
    await c;
    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('kills the child after 2s if it is still alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { child, engine, started } = setup();
    await started;
    const c = engine.close();
    await vi.advanceTimersByTimeAsync(1900);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(child.kill).toHaveBeenCalled();
    child.emit('exit', null, 'SIGTERM');
    await c;
  });
});
