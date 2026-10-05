/**
 * ALI-1448: `align adjudicate` clears a CI gate as a human, so the gateway records its answer
 * as a person's. That is only honest if a person ran it, so the command refuses anything that
 * is not a terminal, the same way `align ratify` does: a hook, a pipe and an agent's shell all
 * arrive with a stdin that is not a TTY.
 *
 * Test List:
 * L1  stdin not a TTY: exit 1, stderr says why, adjudicateCheck never called
 * L1b stdin not a TTY and a bad --verdict: the TTY refusal fires first
 * L2  stdin a TTY: adjudicateCheck(id, 'accepted', note) called once
 * L2b stdin a TTY, --verdict conflicting: called with 'conflicting'
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn() })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('prod'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));
const getEnvironment = vi.hoisted(() => vi.fn().mockReturnValue({ mode: 'cloud' }));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment })) }));
const adjudicateCheck = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ adjudicateCheck })) }));

import { registerAdjudicateCommand } from '../commands/adjudicate.js';

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
  registerAdjudicateCommand(program);
  try {
    await program.parseAsync(['node', 'align', 'adjudicate', ...args]);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

const inTty = process.stdin.isTTY;
function setStdinTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  adjudicateCheck.mockReset().mockResolvedValue({ alreadyAdjudicated: false, verdict: 'accepted' });
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
});

describe('align adjudicate refuses a caller that is not a person at a terminal', () => {
  it('L1 a piped stdin exits 1, says why, and never records an answer', async () => {
    setStdinTty(false);
    await run(['ev-1', '--verdict', 'accepted', '--note', 'x']);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/hook|pipe|agent/i);
    expect(err.join('\n')).toMatch(/terminal/i);
    expect(adjudicateCheck).not.toHaveBeenCalled();
  });

  it('L1b refuses on the terminal before judging the verdict', async () => {
    setStdinTty(false);
    await run(['ev-1', '--verdict', 'nonsense']);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/terminal/i);
    expect(err.join('\n')).not.toMatch(/must be one of/);
  });
});

describe('align adjudicate from a terminal', () => {
  it('L2 records the answer once', async () => {
    setStdinTty(true);
    await run(['ev-1', '--verdict', 'accepted', '--note', 'x']);
    expect(exitCode).toBeUndefined();
    expect(adjudicateCheck).toHaveBeenCalledTimes(1);
    expect(adjudicateCheck).toHaveBeenCalledWith('ev-1', 'accepted', 'x');
  });

  it('L2b passes a conflicting answer through', async () => {
    setStdinTty(true);
    adjudicateCheck.mockResolvedValue({ alreadyAdjudicated: false, verdict: 'conflicting' });
    await run(['ev-2', '--verdict', 'conflicting']);
    expect(adjudicateCheck).toHaveBeenCalledWith('ev-2', 'conflicting', undefined);
  });
});
