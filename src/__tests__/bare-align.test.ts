import { beforeEach, describe, expect, it, vi } from 'vitest';

const runSetup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../commands/setup.js', () => ({ runSetup, registerSetupCommand: vi.fn() }));

const getEnvironment = vi.hoisted(() => vi.fn());
const getDefaultEnv = vi.hoisted(() => vi.fn().mockReturnValue('prod'));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment, getDefaultEnv })),
}));

const listDecisions = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ listDecisions })),
}));

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
    listDecisions.mockReset().mockResolvedValue([]);
    getEnvironment.mockReset();
    getDefaultEnv.mockReturnValue('prod');
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
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    await bare();
    expect(runSetup).toHaveBeenCalledTimes(1);
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
   * Every command it prints has to be runnable AS PRINTED. A bare `align decisions list`
   * resolves to the cloud default and 401s for a local-only user (ALI-772), so suggesting it
   * unqualified would hand a brand-new user an auth error as their next step.
   */
  it('suggests commands qualified with the env they resolve to', async () => {
    getEnvironment.mockImplementation((n: string) =>
      n === 'local' ? { mode: 'local-embedded', localDbPath: '/tmp/local.db' } : { mode: 'cloud' });
    listDecisions.mockResolvedValue([{ id: 'a' }]);
    const out = await bare();
    // Unconditional. An earlier version guarded this behind `if (out includes 'decisions
    // list')`, which is an assertion that cannot fail: drop the suggestion entirely and it
    // still passes.
    expect(out).toContain('align decisions list');
    expect(out).toContain('align ask "why postgres"');
    // And NO --env flag anywhere. Since ALI-772 every command here resolves to the local
    // graph on its own, so printing the flag would teach one nobody needs. This assertion is
    // the reason that stays true: it was printing `--env local` on every line until the
    // redirect made it unnecessary.
    expect(out).not.toContain('--env');
  });

  it('points an empty graph at importing, and a full one at asking', async () => {
    getEnvironment.mockImplementation((n: string) =>
      n === 'local' ? { mode: 'local-embedded', localDbPath: '/tmp/local.db' } : { mode: 'cloud' });

    listDecisions.mockResolvedValue([]);
    expect(await bare()).toMatch(/align import git/);

    listDecisions.mockResolvedValue([{ id: 'a' }]);
    expect(await bare()).toMatch(/align ask/);
  });
});
