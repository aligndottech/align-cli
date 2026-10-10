/**
 * Real loopback servers (no mocked fetch): a redirect must never carry the body to another host,
 * and a gateway that never answers must cost a bounded wait.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';

vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => undefined,
    getTelemetryNoticeShownAt: () => '2026-10-10T00:00:00.000Z',
    wasFunnelStageRecorded: () => false,
    markFunnelStageRecorded: () => {},
    getEnvironment: () => ({ gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' }),
  }),
}));
import { recordCommandUsage, recordFunnelStage } from '../lib/usage-telemetry.js';

const local = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
const servers: http.Server[] = [];
async function listen(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}
const M = { count: 1, source: 'github', outcome: 'ok', scope: 'yours', trigger: 'manual' } as const;

beforeEach(() => clearTelemetryEnv());
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
});

describe('redirects', () => {
  it.each([302, 307, 308])('a %s from the gateway is not followed: the body never reaches the target', async (status) => {
    const hits: string[] = [];
    const target = await listen((req, res) => { hits.push(req.url ?? ''); req.resume(); res.end('x'); });
    const gw = await listen((_req, res) => { res.writeHead(status, { location: `http://127.0.0.1:${target}/collect` }); res.end(); });
    vi.stubEnv('ALIGN_GATEWAY_URL', `http://127.0.0.1:${gw}`);
    await recordCommandUsage(local, 'sync');
    await recordFunnelStage(local, 'source_synced', 'sync', M);
    expect(hits).toEqual([]);
  });
  it('positive control: a plain 201 is delivered to the gateway itself', async () => {
    const bodies: string[] = [];
    const gw = await listen((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { bodies.push(b); res.writeHead(201); res.end('{}'); }); });
    vi.stubEnv('ALIGN_GATEWAY_URL', `http://127.0.0.1:${gw}`);
    await recordFunnelStage(local, 'source_synced', 'sync', M);
    expect(bodies).toHaveLength(1);
  });
});

describe('a gateway that never answers', () => {
  it('a source_synced ping with capMs 300 gives up in about that long', async () => {
    const gw = await listen(() => {});
    vi.stubEnv('ALIGN_GATEWAY_URL', `http://127.0.0.1:${gw}`);
    const t = Date.now();
    await recordFunnelStage(local, 'source_synced', 'sync', M, { capMs: 300 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('a command ping with capMs 300 gives up in about that long', async () => {
    const gw = await listen(() => {});
    vi.stubEnv('ALIGN_GATEWAY_URL', `http://127.0.0.1:${gw}`);
    const t = Date.now();
    await recordCommandUsage(local, 'sync', { capMs: 300 });
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
