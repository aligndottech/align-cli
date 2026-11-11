/**
 * The Pi adapter, tested without a model: createAgentSession is the module boundary and is injected,
 * so nothing here calls a provider. What matters is that Pi's wire shapes become Align's vocabulary
 * (ToolAsk, AgentUiEvent) and that EVERY tool call waits on the broker, failing closed.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as piSdk from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphToolSpec } from '../lib/agent/graph-tools.js';
import { createPiEngine, createToolGate } from '../lib/agent/engines/pi.js';
import type { AgentUiEvent, BrokerVerdict, ToolAsk } from '../lib/agent/types.js';

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | void>;

/** Runs the gate factory against a fake ExtensionAPI and hands back the tool_call handler it registered. */
function toolCallHandler(factory: ReturnType<typeof createToolGate>): Handler {
  let handler: Handler | undefined;
  void factory({ on: (name: string, h: Handler) => { if (name === 'tool_call') handler = h; return () => {}; } } as never);
  if (!handler) throw new Error('the gate registered no tool_call handler');
  return handler;
}

const CWD = '/work/repo';
const allow: BrokerVerdict = { allow: true };

describe('tool_call gate', () => {
  it('blocks with the broker message when the broker denies an edit', async () => {
    const asks: ToolAsk[] = [];
    const broker = vi.fn(async (ask: ToolAsk): Promise<BrokerVerdict> => { asks.push(ask); return { allow: false, message: 'Stopped: decision #7089 says no.' }; });
    const handler = toolCallHandler(createToolGate(() => broker, CWD));
    const result = await handler({ type: 'tool_call', toolCallId: 't1', toolName: 'edit', input: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] } }, {});
    expect(result).toEqual({ block: true, reason: 'Stopped: decision #7089 says no.' });
    expect(asks[0]).toMatchObject({
      id: 't1', tool: 'edit', kind: 'edit',
      edit: { file_path: resolve(CWD, 'src/a.ts'), edits: [{ old_string: 'a', new_string: 'b' }] },
    });
  });

  it('lets a call through (returns undefined) when the broker allows a bash command', async () => {
    const asks: ToolAsk[] = [];
    const handler = toolCallHandler(createToolGate(() => async (ask) => { asks.push(ask); return allow; }, CWD));
    const result = await handler({ type: 'tool_call', toolCallId: 't2', toolName: 'bash', input: { command: 'npm test' } }, {});
    expect(result).toBeUndefined();
    expect(asks[0]).toMatchObject({ id: 't2', tool: 'bash', kind: 'command', command: 'npm test' });
  });

  it('write carries its content, resolved against the working directory', async () => {
    const asks: ToolAsk[] = [];
    const handler = toolCallHandler(createToolGate(() => async (ask) => { asks.push(ask); return allow; }, CWD));
    await handler({ type: 'tool_call', toolCallId: 't3', toolName: 'write', input: { path: '/abs/new.ts', content: 'x' } }, {});
    expect(asks[0]).toMatchObject({ kind: 'edit', edit: { file_path: resolve('/abs/new.ts'), content: 'x' } });
  });

  it('classifies the read tools and the graph tools as read, and everything else as other', async () => {
    const kinds: string[] = [];
    const handler = toolCallHandler(createToolGate(() => async (ask) => { kinds.push(`${ask.tool}:${ask.kind}`); return allow; }, CWD));
    for (const toolName of ['read', 'grep', 'find', 'ls', 'align_ask', 'fetch_url']) await handler({ type: 'tool_call', toolCallId: toolName, toolName, input: {} }, {});
    expect(kinds).toEqual(['read:read', 'grep:read', 'find:read', 'ls:read', 'align_ask:read', 'fetch_url:other']);
  });

  it('fails closed: no broker yet, or a broker that throws, blocks the call', async () => {
    const call = { type: 'tool_call', toolCallId: 't4', toolName: 'bash', input: { command: 'rm -rf x' } };
    const before = await toolCallHandler(createToolGate(() => undefined, CWD))(call, {});
    expect(before).toMatchObject({ block: true });
    const broken = await toolCallHandler(createToolGate(() => async () => { throw new Error('gate crashed'); }, CWD))(call, {});
    expect(broken).toMatchObject({ block: true });
    expect(broken?.reason).toContain('gate crashed');
  });
});

// ---------- the engine, around an injected createAgentSession ----------

type Listener = (e: Record<string, unknown>) => void;

function fakeSession() {
  let listener: Listener = () => {};
  const session = {
    subscribe: vi.fn((l: Listener) => { listener = l; return () => {}; }),
    prompt: vi.fn(async (_text: string) => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return { session, emit: (e: Record<string, unknown>) => listener(e) };
}

const graphTool: GraphToolSpec = {
  name: 'align_ask', description: 'Ask the graph', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  run: async (a) => `answer to ${String(a['question'])}`,
};

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'align-pi-engine-')); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

async function build(model = { provider: 'anthropic', modelId: 'claude-sonnet-5-5', apiKey: 'sk-ant-test', label: 'Anthropic claude-sonnet-5-5' }) {
  const fake = fakeSession();
  const create = vi.fn(async (_o: Record<string, unknown>) => ({ session: fake.session }));
  const engine = await createPiEngine({ cwd: stateDir, stateDir, model, tools: [graphTool] }, { sdk: piSdk, createAgentSession: create as never });
  const events: AgentUiEvent[] = [];
  return { fake, create, engine, events, options: () => create.mock.calls[0]![0] as Record<string, any> };
}

describe('createPiEngine trust', () => {
  async function loaderOptions(trustedDir: string | undefined): Promise<Record<string, any>> {
    const seen: Array<Record<string, any>> = [];
    class Spy extends piSdk.DefaultResourceLoader {
      constructor(o: ConstructorParameters<typeof piSdk.DefaultResourceLoader>[0]) { super(o); seen.push(o as never); }
    }
    const model = { provider: 'anthropic', modelId: 'claude-sonnet-5-5', apiKey: 'sk-ant-test', label: 'Anthropic claude-sonnet-5-5' };
    const create = vi.fn(async () => ({ session: fakeSession().session }));
    await createPiEngine({ cwd: stateDir, stateDir, model, tools: [], trustedDir }, { sdk: { ...piSdk, DefaultResourceLoader: Spy } as never, createAgentSession: create as never });
    return seen[0]!;
  }
  it('hands the trusted folder to the loader, so its prompt folder is read only then', async () => {
    mkdirSync(join(stateDir, '.pi', 'prompts'), { recursive: true });
    expect((await loaderOptions(stateDir))['additionalPromptTemplatePaths']).toEqual([join(stateDir, '.pi', 'prompts')]);
    expect((await loaderOptions(undefined))['additionalPromptTemplatePaths']).toEqual([]);
  });
});

describe('createPiEngine', () => {
  it('labels the engine from the resolved model', async () => {
    expect((await build()).engine.label).toBe('Anthropic claude-sonnet-5-5');
  });

  it('enables the built-in tools and the graph tools, and nothing else', async () => {
    const { options } = await build();
    expect(options().tools).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'align_ask']);
    expect(options().customTools.map((t: { name: string }) => t.name)).toEqual(['align_ask']);
    expect(options().agentDir).toBe(join(stateDir, 'agent'));
  });

  it('a graph tool runs the spec and hands back text', async () => {
    const { options } = await build();
    const tool = options().customTools[0];
    const result = await tool.execute('c1', { question: 'why' }, undefined, undefined, {});
    expect(result.content).toEqual([{ type: 'text', text: 'answer to why' }]);
  });

  it('registers the Anthropic key in-process and resolves the catalogue model', async () => {
    const { options } = await build();
    expect(options().model).toMatchObject({ provider: 'anthropic', id: 'claude-sonnet-5-5' });
    expect(options().modelRuntime.hasConfiguredAuth('anthropic')).toBe(true);
  });

  it('registers Ollama as an OpenAI-compatible provider at its endpoint', async () => {
    const { options } = await build({ provider: 'ollama', modelId: 'qwen2.5-coder:7b', apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1', label: 'Ollama qwen2.5-coder:7b' } as never);
    expect(options().model).toMatchObject({ provider: 'ollama', id: 'qwen2.5-coder:7b', baseUrl: 'http://localhost:11434/v1' });
  });

  it('wires the gate to the broker given to start(): a denied edit is blocked', async () => {
    const { options, engine, events } = await build();
    await engine.start((e) => events.push(e), async () => ({ allow: false, message: 'no' }));
    const loader = options().resourceLoader;
    await loader.reload();
    const handler = loader.getExtensions().extensions.flatMap((x: { handlers: Map<string, Handler[]> }) => x.handlers.get('tool_call') ?? [])[0] as Handler;
    expect(await handler({ type: 'tool_call', toolCallId: 'x', toolName: 'edit', input: { path: 'a.ts', edits: [] } }, {})).toEqual({ block: true, reason: 'no' });
  });

  it('maps Pi session events to Align UI events', async () => {
    const { fake, engine, events } = await build();
    await engine.start((e) => events.push(e), async () => allow);
    fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } });
    fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
    fake.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'npm test' } });
    fake.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: {}, isError: false });
    fake.emit({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'edit', args: { path: 'src/a.ts', edits: [] } });
    fake.emit({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'edit', result: {}, isError: true });
    fake.emit({ type: 'agent_end', messages: [], willRetry: false });
    expect(events).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'tool-start', id: 'c1', tool: 'bash', summary: 'npm test' },
      { type: 'tool-end', id: 'c1', ok: true },
      { type: 'tool-start', id: 'c2', tool: 'edit', summary: 'src/a.ts' },
      { type: 'tool-end', id: 'c2', ok: false },
      { type: 'turn-end' },
    ]);
  });

  it('reports a provider failure instead of an empty turn, and waits out a retry', async () => {
    const { fake, engine, events } = await build();
    await engine.start((e) => events.push(e), async () => allow);
    fake.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '401 bad key' }], willRetry: true });
    expect(events).toEqual([]);
    fake.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '401 bad key' }], willRetry: false });
    expect(events).toEqual([{ type: 'error', message: '401 bad key' }, { type: 'turn-end' }]);
  });

  it('prompt() sends the text and resolves; a rejected prompt becomes an error plus turn-end', async () => {
    const { fake, engine, events } = await build();
    await engine.start((e) => events.push(e), async () => allow);
    await engine.prompt('change the pool size');
    expect(fake.session.prompt).toHaveBeenCalledWith('change the pool size');
    expect(events).toEqual([]);
    fake.session.prompt.mockRejectedValueOnce(new Error('network down'));
    await engine.prompt('again');
    expect(events).toEqual([{ type: 'error', message: 'network down' }, { type: 'turn-end' }]);
  });

  it('abort() and close() reach the session', async () => {
    const { fake, engine, events } = await build();
    await engine.start((e) => events.push(e), async () => allow);
    engine.abort();
    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    await engine.close();
    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('tool_call gate: Align\'s own graph tools', () => {
  it('passes them to the broker as reads, so asking the graph never interrupts the person', async () => {
    const asks: ToolAsk[] = [];
    const broker = vi.fn(async (ask: ToolAsk): Promise<BrokerVerdict> => { asks.push(ask); return allow; });
    const handler = toolCallHandler(createToolGate(() => broker, CWD));
    await handler({ type: 'tool_call', toolCallId: 'g1', toolName: 'align_ask', input: { query: 'why 400-599' } }, {});
    await handler({ type: 'tool_call', toolCallId: 'g2', toolName: 'align_get_topic_timeline', input: { topic: 'status codes' } }, {});
    expect(asks.map((a) => a.kind)).toEqual(['read', 'read']);
  });
});

describe('tool_call gate: unknown tools carry their input', () => {
  it('puts the input on the ask, so a person approves what will run', async () => {
    const asks: ToolAsk[] = [];
    const handler = toolCallHandler(createToolGate(() => async (ask) => { asks.push(ask); return allow; }, CWD));
    await handler({ type: 'tool_call', toolCallId: 'x1', toolName: 'fetch_url', input: { url: 'https://a.example' } }, {});
    expect(asks[0]).toMatchObject({ kind: 'other', detail: '{"url":"https://a.example"}' });
  });
});
