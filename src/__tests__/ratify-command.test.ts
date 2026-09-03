/**
 * ALI-831: `align ratify <id>` - the human act. An agent must not be able to ratify its own
 * premise, so the command refuses anything that is not a person at a terminal: a hook and a
 * pipe both arrive with stdin that is not a TTY. This mirrors the cloud route's 403 for a
 * service account, locally, in the same fail direction.
 *
 * Test List:
 * 1. stdin not a TTY: exits non-zero, says why (hook / pipe), and the client is never called
 * 2. stdin a TTY: calls ratifyDecision with the id and the resolved human identity, prints
 *    who ratified
 * 3. already ratified: says so and who, exit 0
 * 4. the client throws (no such id): exit non-zero with the message
 * 5. the identity comes from git config, falling back to the OS user
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn() })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));
const getEnvironment = vi.hoisted(() => vi.fn().mockReturnValue({ mode: 'local-embedded', localDbPath: '/tmp/x.db' }));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment })) }));
const ratifyDecision = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ ratifyDecision })) }));
const getGitIdentity = vi.hoisted(() => vi.fn());
vi.mock('../lib/git.js', () => ({
  getGitIdentity,
  resolveLocalIdentity: async () => (await getGitIdentity()) ?? 'os-fallback-user',
}));

import { registerRatifyCommand } from '../commands/ratify.js';

const out: string[] = [];
const err: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });

let exitCode: number | undefined;
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  exitCode = code;
  throw new Error(`process.exit(${code})`);
}) as never);

async function run(args: string[]): Promise<void> {
  out.length = 0; err.length = 0; exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerRatifyCommand(program);
  try {
    await program.parseAsync(['node', 'align', 'ratify', ...args]);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

const inTty = process.stdin.isTTY;
function setStdinTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  ratifyDecision.mockReset();
  getGitIdentity.mockReset().mockResolvedValue('tom@align.tech');
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
});

describe('align ratify refuses a caller that is not a person at a terminal', () => {
  it('a piped stdin (a hook, a pipe, an agent shell) exits non-zero, says why, and never writes', async () => {
    setStdinTty(false);
    await run(['d1']);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/hook|pipe/i);
    expect(err.join('\n')).toMatch(/terminal/i);
    expect(ratifyDecision).not.toHaveBeenCalled();
  });
});

describe('align ratify from a terminal', () => {
  it('ratifies as the git identity and says so', async () => {
    setStdinTty(true);
    ratifyDecision.mockResolvedValue({ alreadyRatified: false, ratifiedBy: 'tom@align.tech', ratifiedAt: '2026-09-03T14:00:00.000Z' });
    await run(['d1']);
    expect(exitCode).toBeUndefined();
    expect(ratifyDecision).toHaveBeenCalledWith('d1', { ratifiedBy: 'tom@align.tech' });
    expect(out.join('\n')).toMatch(/ratified/i);
    expect(out.join('\n')).toContain('tom@align.tech');
  });

  it('falls back to the OS user when git has no identity, so the act is still attributed', async () => {
    setStdinTty(true);
    getGitIdentity.mockResolvedValue(null);
    ratifyDecision.mockResolvedValue({ alreadyRatified: false, ratifiedBy: 'x', ratifiedAt: '2026-09-03T14:00:00.000Z' });
    await run(['d1']);
    const by = ratifyDecision.mock.calls[0]?.[1]?.ratifiedBy;
    expect(typeof by).toBe('string');
    expect(by.length).toBeGreaterThan(0);
  });

  it('says who already ratified, and exits 0: the first answer stands', async () => {
    setStdinTty(true);
    ratifyDecision.mockResolvedValue({ alreadyRatified: true, ratifiedBy: 'dan@align.tech', ratifiedAt: '2026-09-01T10:00:00.000Z' });
    await run(['d1']);
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toMatch(/already/i);
    expect(out.join('\n')).toContain('dan@align.tech');
  });

  it('exits non-zero with the message when the graph does not hold the id', async () => {
    setStdinTty(true);
    ratifyDecision.mockRejectedValue(new Error('No decision d9 in your local graph.'));
    await run(['d9']);
    expect(exitCode).toBe(1);
  });
});
