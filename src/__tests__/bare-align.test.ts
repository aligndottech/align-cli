import { beforeEach, describe, expect, it, vi } from 'vitest';

const runSetup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../commands/setup.js', () => ({ runSetup, registerSetupCommand: vi.fn() }));

const printBanner = vi.hoisted(() => vi.fn().mockReturnValue(true));
vi.mock('../lib/brand.js', () => ({ printBanner }));

const getEnvironment = vi.hoisted(() => vi.fn());
const getDefaultEnv = vi.hoisted(() => vi.fn().mockReturnValue('prod'));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment, getDefaultEnv })),
}));

const listDecisions = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ listDecisions })),
}));

// ALI-950: the card names the agents wired NOW (global configs carrying an align entry, and
// this repo's .mcp.json), and reuses the ALI-215 readout `align status` prints.
const detectWiredEditors = vi.hoisted(() => vi.fn().mockReturnValue([]));
const projectMcpAgents = vi.hoisted(() => vi.fn().mockReturnValue([]));
vi.mock('../lib/mcp-setup.js', () => ({ detectWiredEditors, projectMcpAgents }));
const readValueRollup = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('no readout')));
vi.mock('../lib/read-value-rollup.js', () => ({ readValueRollup }));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });

import { runDefaultAction } from '../commands/default-action.js';

async function bare(): Promise<string> {
  output.length = 0;
  await runDefaultAction();
  return output.join('\n');
}

/**
 * ALI-773. A new user's first instinct is to type the tool's name, and `align` printed a
 * twenty-command help wall and did nothing - leaving them to pick correctly out of setup,
 * login, local, import, capture, context and env before anything happened.
 *
 * The tool knows whether it is set up. It should act on that rather than asking the reader
 * to work it out.
 */
describe('bare `align`', () => {
  beforeEach(() => {
    runSetup.mockClear();
    printBanner.mockClear();
    listDecisions.mockReset().mockResolvedValue([]);
    getEnvironment.mockReset();
    getDefaultEnv.mockReturnValue('prod');
    detectWiredEditors.mockReset().mockReturnValue([]);
    projectMcpAgents.mockReset().mockReturnValue([]);
    readValueRollup.mockReset().mockRejectedValue(new Error('no readout'));
  });

  /**
   * Onboarding asks questions. Without a TTY those prompts cannot be answered, and starting
   * anyway leaves a half-drawn cancelled prompt and no explanation - measured on the built
   * binary with stdin closed, which is what a pipe, a CI step or a Dockerfile gives it.
   */
  it('explains what to run instead when there is no TTY', async () => {
    const inTty = process.stdin.isTTY, outTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      getEnvironment.mockImplementation(() => ({ mode: 'cloud' }));
      const out = await bare();
      expect(runSetup).not.toHaveBeenCalled();
      expect(out).toContain('align setup');
      // The non-interactive escape hatch, so a scripted first run has an answer too.
      expect(out).toContain('align setup --local --approve');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
    }
  });

  it('runs onboarding when nothing is set up', async () => {
    // no local graph, no cloud token
    getEnvironment.mockImplementation((n: string) => (n === 'local' ? { mode: 'cloud' } : { mode: 'cloud' }));
    // Restored in `finally` like its siblings (Copilot on #237): a forced isTTY that
    // outlives the test leaks into whatever runs next, and an order-dependent green
    // is the kind that turns red only on the runner.
    const inTty = process.stdin.isTTY, outTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await bare();
      expect(runSetup).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
    }
  });

  it('does NOT re-run onboarding for a local user who is already set up', async () => {
    getEnvironment.mockImplementation((n: string) =>
      n === 'local' ? { mode: 'local-embedded', localDbPath: '/home/d/.config/align-cli/local.db' } : { mode: 'cloud' });
    listDecisions.mockResolvedValue([{ id: 'a' }]);
    const out = await bare();
    expect(runSetup).not.toHaveBeenCalled();
    expect(out).toMatch(/local/i);
  });

  it('does NOT re-run onboarding for a signed-in cloud user', async () => {
    getEnvironment.mockImplementation((n: string) =>
      n === 'local' ? { mode: 'cloud' } : { mode: 'cloud', authToken: 'tok' });
    listDecisions.mockResolvedValue([{ id: 'a' }]);
    await bare();
    expect(runSetup).not.toHaveBeenCalled();
  });

  /**
   * ALI-950: no CLI verb on the card. It used to suggest `align ask "why postgres"`,
   * `align decisions list`, `align import git` and `align --help` - every next step a verb
   * to type, when the product's whole value is a question asked in the agent. The regex is
   * proven against that old text in next-step.test.ts, so a clean pass here is not vacuous.
   * And still no --env flag anywhere (ALI-772): every path resolves to the local graph on
   * its own, so printing the flag would teach one nobody needs.
   */
  it('names no CLI verb on the card, and no --env flag', async () => {
    getEnvironment.mockImplementation((n: string) =>
      n === 'local' ? { mode: 'local-embedded', localDbPath: '/tmp/local.db' } : { mode: 'cloud' });
    listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
    projectMcpAgents.mockReturnValue(['Claude Code']);
    const out = await bare();
    expect(out).not.toMatch(/\balign\s+[a-z-]+/);
    expect(out).not.toContain('--env');
    expect(out).not.toContain('--help');
  });

  it('points an empty graph at importing, and a full one at asking - in the agent', async () => {
    getEnvironment.mockImplementation((n: string) =>
      n === 'local' ? { mode: 'local-embedded', localDbPath: '/tmp/local.db' } : { mode: 'cloud' });
    projectMcpAgents.mockReturnValue(['Claude Code']);

    // The one verb the card may ever name (ALI-951 renames it `align connect`).
    listDecisions.mockResolvedValue([]);
    const empty = await bare();
    expect(empty).toMatch(/align import git/);
    expect(empty.match(/\balign\s+[a-z-]+/g)).toHaveLength(1);
    expect(empty).not.toMatch(/and ask:/);

    listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
    const full = await bare();
    expect(full).toContain('Open Claude Code and ask: why did we switch to postgres?');
    expect(full.match(/and ask:/g)).toHaveLength(1);
  });

  /**
   * ALI-950: the card shows the graph, the agents wired by name, the ALI-215 "what your graph
   * did for you" readout, and exactly one next action, which happens in the agent.
   */
  describe('the second-run card (ALI-950)', () => {
    const localEnv = (n: string) =>
      n === 'local' ? { mode: 'local-embedded', localDbPath: '/home/d/.config/align-cli/local.db' } : { mode: 'cloud' };
    const cloudEnv = (n: string) => (n === 'local' ? { mode: 'cloud' } : { mode: 'cloud', authToken: 'tok' });

    it('names the agents wired by name, the one in this repo\'s project config first', async () => {
      getEnvironment.mockImplementation(localEnv);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
      projectMcpAgents.mockReturnValue(['Claude Code']);
      detectWiredEditors.mockReturnValue([{ name: 'Cursor' }, { name: 'Claude Code' }]);
      const out = await bare();
      expect(out).toContain('Agents       Claude Code, Cursor');
      expect(out).toContain('Open Claude Code and ask: why did we switch to postgres?');
      expect(projectMcpAgents).toHaveBeenCalledWith(process.cwd());
    });

    it('with no project config, the first globally wired agent leads', async () => {
      getEnvironment.mockImplementation(localEnv);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
      detectWiredEditors.mockReturnValue([{ name: 'Cursor' }, { name: 'Zed' }]);
      expect(await bare()).toContain('Open Cursor and ask: why did we switch to postgres?');
    });

    it('cloud: shows this week\'s conflicts and reuse rate from the ALI-215 readout, read for a 7-day window', async () => {
      getEnvironment.mockImplementation(cloudEnv);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
      projectMcpAgents.mockReturnValue(['Claude Code']);
      readValueRollup.mockResolvedValue({
        mode: 'cloud',
        rollup: { decisions: 142, conflictsCaught: 6, similarDecisions: 0, duplicates: 0, supersessions: 0, reuseRate: 0.72, healthGrade: null, gaps: [] },
      });
      const out = await bare();
      expect(out).toContain('Signed in    prod');
      expect(out).toContain('This week    6 conflicts caught, reuse rate 72%');
      expect(readValueRollup).toHaveBeenCalledWith(expect.anything(), 'prod', { days: 7 });
    });

    it('local: says what it knows so far, with no conflict counter at zero (ALI-503)', async () => {
      getEnvironment.mockImplementation(localEnv);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
      projectMcpAgents.mockReturnValue(['Claude Code']);
      readValueRollup.mockResolvedValue({
        mode: 'local',
        rollup: { decisions: 12, conflictsCaught: 0, similarDecisions: 0, duplicates: 0, supersessions: 0, reuseRate: null, healthGrade: null, gaps: [] },
      });
      const out = await bare();
      expect(out).toContain('Local graph  /home/d/.config/align-cli/local.db');
      expect(out).toContain('So far       12 decisions in your graph');
      expect(out).not.toMatch(/conflicts caught/);
      expect(readValueRollup).toHaveBeenCalledWith(expect.anything(), 'local', { days: 7 });
    });

    it('a readout that cannot be read leaves the line out and still prints the card', async () => {
      getEnvironment.mockImplementation(localEnv);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
      projectMcpAgents.mockReturnValue(['Claude Code']);
      readValueRollup.mockRejectedValue(new Error('gateway down'));
      const out = await bare();
      expect(out).not.toMatch(/So far|This week/);
      expect(out).toContain('Open Claude Code and ask:');
    });

    it('no agent detected: says so and names align mcp once', async () => {
      getEnvironment.mockImplementation(localEnv);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
      const out = await bare();
      expect(out).toContain('Agents       none detected');
      expect(out).toContain('No agent detected. Run align mcp --setup --env local, then ask it: why did we switch to postgres?');
      expect(out.match(/align mcp/g)).toHaveLength(1);
    });

    it('cloud no-agent line leaves the env off, so the command runs as printed', async () => {
      getEnvironment.mockImplementation(cloudEnv);
      listDecisions.mockResolvedValue([{ id: 'a', title: 'switch to postgres' }]);
      const out = await bare();
      expect(out).toContain('Run align mcp --setup, then ask it:');
      expect(out).not.toContain('--env');
    });
  });

  /**
   * Found live 2026-09-02 (v0.31.1, still present on v0.32.1): a fresh `align` printed
   * the full ASCII lockup TWICE - once here, then again from runSetup's own opening.
   * The banner belongs to whichever flow OWNS the screen: setup prints its own, so the
   * delegating path must not print one first.
   */
  it('leaves the banner to setup when delegating - one lockup, not two', async () => {
    getEnvironment.mockImplementation(() => ({ mode: 'cloud' }));
    const inTty = process.stdin.isTTY, outTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      await bare();

      expect(runSetup).toHaveBeenCalledTimes(1);
      expect(printBanner).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
    }
  });

  it('prints the banner exactly once for an already-set-up user', async () => {
    getEnvironment.mockImplementation((n: string) =>
      n === 'local' ? { mode: 'local-embedded', localDbPath: '/tmp/local.db' } : { mode: 'cloud' });
    listDecisions.mockResolvedValue([{ id: 'a' }]);

    await bare();

    expect(runSetup).not.toHaveBeenCalled();
    expect(printBanner).toHaveBeenCalledTimes(1);
  });
});
