import { ASK_ONCE_GUIDANCE } from '../lib/agent/agent-guidance.js';
import { describe, expect, it, vi } from 'vitest';
import { runAgentSession, type SessionDeps } from '../lib/agent/run-agent-session.js';
import type { AgentEngine } from '../lib/agent/types.js';

const MODEL = { provider: 'anthropic', modelId: 'claude-sonnet-5-5', apiKey: 'sk-ant-saved', label: 'Anthropic claude-sonnet-5-5' };
const fakeEngine = (label: string): AgentEngine => ({ label, start: vi.fn(), prompt: vi.fn(), abort: vi.fn(), close: vi.fn() });

function deps(over: Partial<SessionDeps> = {}) {
  const lines: string[] = [];
  const piEngine = fakeEngine(MODEL.label);
  const ccEngine = fakeEngine('Claude Code');
  const remembered: string[] = [];
  const d: SessionDeps = {
    cwd: '/repo',
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-saved' },
    startupEnv: { PATH: '/bin' },
    out: (l) => lines.push(l),
    getRemembered: () => undefined,
    remember: (e) => remembered.push(e),
    resolveModel: async () => MODEL,
    findClaude: () => '/usr/local/bin/claude',
    projectState: () => ({ projectHasMcp: false, projectHasBlock: false }),
    makeGate: () => async () => ({ kind: 'allow', cards: [] }),
    gitRunsPrograms: async () => false,
    graphTools: () => [],
    countDecisions: () => 749,
    loadPiEngine: async () => ({ createPiEngine: vi.fn(async () => piEngine) }),
    createClaudeCodeEngine: vi.fn(() => ccEngine),
    runAgentUi: vi.fn(async () => 0),
    record: vi.fn(),
    backgroundSync: vi.fn(() => []),
    ...over,
  };
  return { d, lines, piEngine, ccEngine, remembered };
}

describe('runAgentSession: nothing can run', () => {
  it('says the three ways forward and starts no UI', async () => {
    const { d, lines } = deps({ resolveModel: async () => undefined, findClaude: () => null });
    expect(await runAgentSession({}, d)).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('align ai');
    expect(text).toContain('ollama');
    expect(text).toContain('Claude Code');
    expect(d.runAgentUi).not.toHaveBeenCalled();
  });
  it('names the engine that was asked for when it cannot run', async () => {
    const { d, lines } = deps({ findClaude: () => null });
    expect(await runAgentSession({ engine: 'claude' }, d)).toBe(1);
    expect(lines.join('\n')).toContain('Claude Code is not installed');
    expect(d.runAgentUi).not.toHaveBeenCalled();
  });
});

describe('runAgentSession: Align\'s own engine', () => {
  it('runs Pi on the resolved model, in Align\'s UI, and reports agent align', async () => {
    const { d, piEngine } = deps();
    expect(await runAgentSession({}, d)).toBe(0);
    const ui = vi.mocked(d.runAgentUi).mock.calls[0]![0];
    expect(ui.engine).toBe(piEngine);
    expect(ui.decisionCount).toBe(749);
    expect(d.record).toHaveBeenCalledWith('align');
  });
  it('falls back to the user\'s Claude Code, and says so, when the engine cannot load', async () => {
    const { d, ccEngine, lines } = deps({ loadPiEngine: async () => { throw new Error('Cannot find module @earendil-works/pi-coding-agent'); } });
    expect(await runAgentSession({}, d)).toBe(0);
    expect(vi.mocked(d.runAgentUi).mock.calls[0]![0].engine).toBe(ccEngine);
    expect(lines.join('\n')).toMatch(/could not start.*Claude Code/s);
    expect(d.record).toHaveBeenCalledWith('claude-code');
  });
  it('does not switch engines behind an explicit --engine align: it says why and stops', async () => {
    const { d, lines } = deps({ loadPiEngine: async () => { throw new Error('no wasm'); } });
    expect(await runAgentSession({ engine: 'align' }, d)).toBe(1);
    expect(d.runAgentUi).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('no wasm');
  });
});

describe('runAgentSession: the user\'s own Claude Code', () => {
  it('runs claude with the startup env, so a key Align saved never reaches it', async () => {
    const { d } = deps({ resolveModel: async () => undefined });
    await runAgentSession({}, d);
    const opts = vi.mocked(d.createClaudeCodeEngine).mock.calls[0]![0];
    expect(opts.bin).toBe('/usr/local/bin/claude');
    expect(opts.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(opts.env['PATH']).toBe('/bin');
    expect(d.record).toHaveBeenCalledWith('claude-code');
  });
  it('injects Align\'s MCP server and instructions only where the project lacks them', async () => {
    const bare = deps({ resolveModel: async () => undefined });
    await runAgentSession({}, bare.d);
    const args = vi.mocked(bare.d.createClaudeCodeEngine).mock.calls[0]![0].extraArgs ?? [];
    expect(args).toContain('--append-system-prompt');
    expect(args.at(-2)).toBe('--mcp-config');
    expect(JSON.parse(args.at(-1)!)).toHaveProperty(['mcpServers', 'align-local']);

    const wired = deps({ resolveModel: async () => undefined, projectState: () => ({ projectHasMcp: true, projectHasBlock: true }) });
    await runAgentSession({}, wired.d);
    const wiredArgs = vi.mocked(wired.d.createClaudeCodeEngine).mock.calls[0]![0].extraArgs ?? [];
    // Only the ask-once line: the project already carries Align's block and MCP server.
    expect(wiredArgs).toEqual(['--append-system-prompt', ASK_ONCE_GUIDANCE]);
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain(ASK_ONCE_GUIDANCE);
  });
});

describe('runAgentSession: remembering the choice', () => {
  it('remembers an explicit --engine', async () => {
    const { d, remembered } = deps();
    await runAgentSession({ engine: 'claude' }, d);
    expect(remembered).toEqual(['claude']);
  });
  it('does not remember a default it picked itself', async () => {
    const { d, remembered } = deps();
    await runAgentSession({}, d);
    expect(remembered).toEqual([]);
  });
});

// Bare `align` opens this session, not the launcher, so the 15-minute refresh has to start here too
// or a connected Jira or Slack never updates after its first scan. Its lines go into the screen:
// the full-screen UI repaints the terminal, so a line printed before it would be lost.
describe('runAgentSession: the background refresh', () => {
  it('starts before the screen opens and its line reaches the screen', async () => {
    const order: string[] = [];
    const { d } = deps({
      backgroundSync: vi.fn(() => { order.push('sync'); return ['Refreshing jira in the background.']; }),
      runAgentUi: vi.fn(async () => { order.push('ui'); return 0; }),
    });
    await runAgentSession({}, d);
    expect(order).toEqual(['sync', 'ui']);
    expect(vi.mocked(d.runAgentUi).mock.calls[0]![0].notices).toEqual(['Refreshing jira in the background.']);
  });
  it('passes every line it gives, whatever they say', async () => {
    const { d } = deps({ backgroundSync: () => ['Refreshing slack, linear in the background.', 'Align cannot refresh notion: reconnect.'] });
    await runAgentSession({}, d);
    expect(vi.mocked(d.runAgentUi).mock.calls[0]![0].notices).toEqual(['Refreshing slack, linear in the background.', 'Align cannot refresh notion: reconnect.']);
  });
  it('a refresh that throws never stops the agent opening', async () => {
    const { d } = deps({ backgroundSync: () => { throw new Error('lock dir unwritable'); } });
    expect(await runAgentSession({}, d)).toBe(0);
    expect(vi.mocked(d.runAgentUi).mock.calls[0]![0].notices).toEqual([]);
  });
  it('no refresh starts when nothing can run', async () => {
    const { d } = deps({ resolveModel: async () => undefined, findClaude: () => null });
    await runAgentSession({}, d);
    expect(d.backgroundSync).not.toHaveBeenCalled();
  });
});
