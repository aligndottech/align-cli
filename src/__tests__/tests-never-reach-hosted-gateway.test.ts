/**
 * No test may reach the hosted gateway. telemetry-doctor.test.ts forced CI=false, faked a
 * terminal and ran the real install beacon with no ALIGN_GATEWAY_URL, so every CI run on every
 * OS sent a fresh install id to production from 18 Oct: about 700 fake installs by 29 Oct, and
 * the anonymous funnel could no longer tell people from test runs. The setup file now refuses
 * any request to the hosted gateway, so the next test that forgets a sink fails closed instead.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALIGN_HOSTED_GATEWAY_URL } from '../lib/config.js';
import { recordInstallBeacon } from '../lib/usage-telemetry.js';

describe('the test setup blocks the hosted gateway', () => {
  it('a request to the hosted gateway rejects before it leaves the process', async () => {
    await expect(fetch(`${ALIGN_HOSTED_GATEWAY_URL}/telemetry/anonymous`, { method: 'POST', body: '{}' })).rejects.toThrow(
      /hosted gateway is blocked in tests/,
    );
  });

  it('CONTROL: a request to any other host still goes through', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});

describe('the install beacon under the conditions that leaked', () => {
  const KEYS = ['CI', 'ALIGN_GATEWAY_URL', 'DO_NOT_TRACK', 'ALIGN_TELEMETRY', 'ALIGN_WRAPPED'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env['CI'] = 'false';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is not delivered when telemetry is granted and no sink is set', async () => {
    const { createConfigStore } = await import('../lib/config.js');
    createConfigStore().setTelemetryConsent('granted');
    expect(await recordInstallBeacon('status')).toBe(false);
  });
});
