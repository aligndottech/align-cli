import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSetup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../commands/setup.js', () => ({ runSetup, addSetupOptions: (c: unknown) => c }));
vi.mock('../lib/brand.js', () => ({ printBanner: vi.fn() }));

const getEnvironment = vi.hoisted(() => vi.fn());
const getAgent = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment, getDefaultEnv: () => 'prod', getAgent })),
}));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ listDecisions: vi.fn().mockResolvedValue([]) })) }));
vi.mock('../lib/mcp-setup.js', () => ({ detectWiredEditors: () => [], projectMcpAgents: () => [] }));
vi.mock('../lib/read-value-rollup.js', () => ({ readValueRollup: vi.fn().mockRejectedValue(new Error('none')) }));

// Both doors out of bare `align` are mocked at their module boundary: the old launcher and the
// new session. What this file pins is which door each invocation takes.
const launchIfChosen = vi.hoisted(() => vi.fn().mockResolvedValue({ handled: true, code: 7 }));
vi.mock('../lib/launch/launch.js', async (importOriginal) => ({ ...(await importOriginal<object>()), launchIfChosen }));
const runAgentSession = vi.hoisted(() => vi.fn().mockResolvedValue(0));
vi.mock('../lib/agent/run-agent-session.js', () => ({ runAgentSession }));

import { runDefaultAction } from '../commands/default-action.js';

const LOCAL = { mode: 'local-embedded', localDbPath: '/home/d/.align/local.db' };
const inTty = process.stdin.isTTY;
const outTty = process.stdout.isTTY;
const argv = process.argv;
function tty(on: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
}

describe('bare `align` on a set-up local graph', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv('ALIGN_WRAPPED', undefined);
    vi.stubEnv('ALIGN_NO_LAUNCH', undefined);
    getEnvironment.mockImplementation((n: string) => (n === 'local' ? LOCAL : { mode: 'cloud' }));
    getAgent.mockReset().mockReturnValue(undefined);
    // Reset with their values, every test: restoreAllMocks below also clears a hoisted mock's
    // implementation, which would leave the next test reading `undefined.handled`.
    launchIfChosen.mockReset().mockResolvedValue({ handled: true, code: 7 });
    runAgentSession.mockReset().mockResolvedValue(0);
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'align'];
    tty(true);
  });
  afterEach(() => {
    tty(Boolean(inTty));
    Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
    process.argv = argv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('opens Align\'s own agent, not the launcher, and exits with its code', async () => {
    runAgentSession.mockResolvedValueOnce(3);
    await runDefaultAction({});
    expect(runAgentSession).toHaveBeenCalledWith({ engine: undefined });
    expect(launchIfChosen).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(3);
  });
  it('opens Align\'s own agent even when a launch agent is saved from before', async () => {
    getAgent.mockReturnValue('claude-code');
    await runDefaultAction({});
    expect(runAgentSession).toHaveBeenCalled();
    expect(launchIfChosen).not.toHaveBeenCalled();
  });
  it('passes --engine through', async () => {
    await runDefaultAction({ engine: 'claude' });
    expect(runAgentSession).toHaveBeenCalledWith({ engine: 'claude' });
  });
  it('keeps `align -- <args>` on the old launcher', async () => {
    process.argv = ['node', 'align', '--', '--resume'];
    await runDefaultAction({});
    expect(launchIfChosen).toHaveBeenCalled();
    expect(runAgentSession).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(7);
  });
  it('opens nothing inside an agent Align already started', async () => {
    vi.stubEnv('ALIGN_WRAPPED', '1');
    await runDefaultAction({});
    expect(runAgentSession).not.toHaveBeenCalled();
  });
  it('opens nothing without a terminal: the card prints as before', async () => {
    tty(false);
    await runDefaultAction({});
    expect(runAgentSession).not.toHaveBeenCalled();
  });
});

describe('bare `align` on first run', () => {
  beforeEach(() => {
    vi.stubEnv('ALIGN_WRAPPED', undefined);
    launchIfChosen.mockReset().mockResolvedValue({ handled: true, code: 7 });
    runAgentSession.mockReset().mockResolvedValue(0);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'align'];
    tty(true);
  });
  afterEach(() => {
    tty(Boolean(inTty));
    Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lands in Align\'s own agent once the wizard has built the graph', async () => {
    getAgent.mockReturnValue('claude-code');
    let built = false;
    getEnvironment.mockImplementation((n: string) => (n === 'local' && built ? LOCAL : { mode: 'cloud' }));
    runSetup.mockReset().mockImplementation(async () => { built = true; return {}; });
    await runDefaultAction({});
    expect(runSetup).toHaveBeenCalled();
    expect(runAgentSession).toHaveBeenCalledWith({ engine: undefined });
    expect(launchIfChosen).not.toHaveBeenCalled();
  });
  it('opens nothing when the wizard did not build a graph (declined, or cancelled)', async () => {
    getEnvironment.mockImplementation(() => ({ mode: 'cloud' }));
    runSetup.mockReset().mockResolvedValue({});
    await runDefaultAction({});
    expect(runAgentSession).not.toHaveBeenCalled();
  });
});
