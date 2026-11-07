/**
 * `align capture <url>` reports the first_capture funnel stage on a successful capture, and
 * only then. Once-per-install is the emitter's job (usage-telemetry-funnel.test.ts); this pins
 * the call site: right stage, right command name, nothing about the link or the decision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const spinner = vi.hoisted(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn(), stop: vi.fn() }));
vi.mock('ora', () => ({ default: vi.fn(() => spinner) }));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));
const ENV = vi.hoisted(() => ({ mode: 'cloud' }));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn().mockReturnValue(ENV) })) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn().mockReturnValue('https://app.example') }));
const captureDecision = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ captureDecision })) }));
const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { registerCaptureCommand } from '../commands/capture.js';

vi.spyOn(console, 'log').mockImplementation(() => undefined);
vi.spyOn(console, 'error').mockImplementation(() => undefined);
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never);

async function run(url: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCaptureCommand(program);
  try {
    await program.parseAsync(['node', 'align', 'capture', url]);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

beforeEach(() => {
  captureDecision.mockReset();
  recordFunnelStage.mockClear();
});

describe('align capture and the first_capture stage', () => {
  it('reports first_capture, with the command name only, after a successful capture', async () => {
    captureDecision.mockResolvedValue({ id: 'd1', title: 'Use Redis', summary: 's', platform: 'github' });
    await run('https://github.com/acme/repo/pull/1');
    expect(recordFunnelStage).toHaveBeenCalledTimes(1);
    expect(recordFunnelStage).toHaveBeenCalledWith(ENV, 'first_capture', 'capture');
  });

  it('reports nothing when the capture fails', async () => {
    captureDecision.mockRejectedValue(Object.assign(new Error('Gateway returned 401'), { statusCode: 401 }));
    await run('https://github.com/acme/repo/pull/1');
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });

  it('reports nothing for a non-URL input, which never reaches the gateway', async () => {
    await run('not a url');
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });
});
