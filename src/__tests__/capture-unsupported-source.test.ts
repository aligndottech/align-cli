/**
 * ALI-1696 (CLI half): `align capture <url>` must exit non-zero and say nothing was saved when the
 * gateway cannot read the link, and must never print "Decision captured" for a failure.
 *
 * Test List:
 *   C1  422 unsupported_source: exit 1, a plain message naming the link, no success line
 *   C2  401 from the gateway: exit 1, no success line
 *   C3  a successful capture prints the decision and does not exit (control for C1/C2)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const spinner = vi.hoisted(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn(), stop: vi.fn() }));
vi.mock('ora', () => ({ default: vi.fn(() => spinner) }));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn().mockReturnValue({ mode: 'cloud' }) })) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn().mockReturnValue('https://app.example') }));
const captureDecision = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ captureDecision })) }));

import { registerCaptureCommand } from '../commands/capture.js';

const out: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
let exitCode: number | undefined;
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  exitCode = code;
  throw new Error(`process.exit(${code})`);
}) as never);

async function run(url: string): Promise<void> {
  out.length = 0; exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerCaptureCommand(program);
  try {
    await program.parseAsync(['node', 'align', 'capture', url]);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

const gatewayError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

beforeEach(() => {
  captureDecision.mockReset();
  spinner.succeed.mockClear();
  spinner.fail.mockClear();
});

describe('align capture on a link the gateway cannot read (ALI-1696)', () => {
  it('C1: 422 unsupported_source exits 1 with a plain message and no success line', async () => {
    captureDecision.mockRejectedValue(gatewayError('Gateway returned 422 for /ingest: unsupported_source', 422));
    await run('https://linear.app/acme/issue/ALI-1');
    expect(exitCode).toBe(1);
    expect(spinner.succeed).not.toHaveBeenCalled();
    expect(spinner.fail.mock.calls[0][0]).toMatch(/cannot read https:\/\/linear\.app/);
    expect(out.join('\n')).toMatch(/Nothing was saved/);
  });

  it('C2: a 401 exits 1 and prints no success line', async () => {
    captureDecision.mockRejectedValue(gatewayError('Gateway returned 401 for /ingest: unauthorized', 401));
    await run('https://linear.app/acme/issue/ALI-1');
    expect(exitCode).toBe(1);
    expect(spinner.succeed).not.toHaveBeenCalled();
  });

  it('C3: a successful capture prints the decision and does not exit', async () => {
    captureDecision.mockResolvedValue({ id: 'd1', title: 'Use Redis', summary: 's', platform: 'github' });
    await run('https://github.com/acme/repo/pull/1');
    expect(exitCode).toBeUndefined();
    expect(spinner.succeed).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toContain('d1');
  });
});
