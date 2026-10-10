import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayClient } from '../lib/gateway-client.js';

/**
 * ALI-1540 Test List, the share-request routes as the CLI reads them (the gateway side is built separately,
 * so these are the contract and the CLI must not believe an answer that does not fit it):
 * - config: 404 is an older gateway (null); a mode this CLI does not know is an ERROR, never a default.
 * - stage: the answer must carry OUR id (the envelope is bound to it), a well-formed code and a real expiry.
 * - status: a state outside the closed list is an error.
 * - every call refuses a redirect; an id that is not a UUID never reaches a path.
 */
const ID = '0b9f3c1e-5d2a-4f8e-9a77-3c1d2e4f5a6b';
const client = () => createGatewayClient({ mode: 'auth', gatewayUrl: 'https://gw.test', authToken: 't', tenantId: 'T' });
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
afterEach(() => { vi.unstubAllGlobals(); });

const stageBody = { envelope_id: '7a1b2c3d-1111-4222-8333-444455556666', kind: 'share' as const, envelope: 'AAAA', payload_sha256: 'a'.repeat(64), item_count: 1, judgement_count: 0 };

describe('config', () => {
  it('reads each mode', async () => {
    for (const mode of ['off', 'available', 'required']) {
      vi.stubGlobal('fetch', answer({ mode, pending_ttl_s: 900, complete_ttl_s: 600 }));
      expect(await client().shareRequestsConfig()).toEqual({ mode, pendingTtlS: 900, completeTtlS: 600 });
    }
  });
  it('treats a 404 as an older gateway (null), but a 500 and a 401 as errors', async () => {
    vi.stubGlobal('fetch', answer({ error: 'not_found' }, 404));
    expect(await client().shareRequestsConfig()).toBeNull();
    vi.stubGlobal('fetch', answer({ error: 'boom' }, 500));
    await expect(client().shareRequestsConfig()).rejects.toThrow(/500/);
    vi.stubGlobal('fetch', answer({ error: 'unauthorized' }, 401));
    await expect(client().shareRequestsConfig()).rejects.toThrow(/401/);
  });
  it('refuses a mode it does not know, and a body with no mode', async () => {
    vi.stubGlobal('fetch', answer({ mode: 'sometimes' }));
    await expect(client().shareRequestsConfig()).rejects.toThrow(/does not recognise/);
    vi.stubGlobal('fetch', answer({}));
    await expect(client().shareRequestsConfig()).rejects.toThrow(/does not recognise/);
  });
});

describe('stage', () => {
  it('uses the SERVER\'s row id, which is not the envelope id the CLI sent', async () => {
    vi.stubGlobal('fetch', answer({ id: ID, user_code: 'KJ4M-9XQT', expires_at: '2026-10-10T12:00:00.000Z' }, 201));
    expect((await client().stageShareRequest(stageBody)).id).toBe(ID);
    expect(stageBody.envelope_id).not.toBe(ID);
  });
  it('returns the id, the code and the expiry it was given', async () => {
    vi.stubGlobal('fetch', answer({ id: ID, user_code: 'KJ4M-9XQT', expires_at: '2026-10-10T12:00:00.000Z' }, 201));
    expect(await client().stageShareRequest(stageBody)).toEqual({ id: ID, userCode: 'KJ4M-9XQT', expiresAt: '2026-10-10T12:00:00.000Z' });
  });
  it.each([
    ['a row id that is not a UUID', { id: '../auth/me', user_code: 'KJ4M-9XQT', expires_at: '2026-10-10T12:00:00.000Z' }],
    ['a malformed code', { id: ID, user_code: 'kj4m-9xqt', expires_at: '2026-10-10T12:00:00.000Z' }],
    ['a code with a letter the alphabet leaves out', { id: ID, user_code: 'KJ4M-9XQO', expires_at: '2026-10-10T12:00:00.000Z' }],
    ['no usable expiry', { id: ID, user_code: 'KJ4M-9XQT', expires_at: 'soon' }],
    ['no code', { id: ID, expires_at: '2026-10-10T12:00:00.000Z' }],
  ])('refuses an answer with %s', async (_n, body) => {
    vi.stubGlobal('fetch', answer(body, 201));
    await expect(client().stageShareRequest(stageBody)).rejects.toThrow(/does not recognise/);
  });
});

describe('status, cancel, complete', () => {
  it('reads a known state and refuses an unknown one', async () => {
    vi.stubGlobal('fetch', answer({ state: 'approved' }));
    expect(await client().getShareRequest(ID)).toEqual({ state: 'approved', expiresAt: null });
    vi.stubGlobal('fetch', answer({ state: 'maybe' }));
    await expect(client().getShareRequest(ID)).rejects.toThrow(/does not recognise/);
  });
  it('sends the approved bytes as payload_b64 and returns the batch answer whole', async () => {
    const f = answer({ snapshots: [{ id: 'R0', request_index: 0 }] });
    vi.stubGlobal('fetch', f);
    expect(await client().completeShareRequest(ID, 'QUJD')).toEqual({ snapshots: [{ id: 'R0', request_index: 0 }] });
    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe(`https://gw.test/share-requests/${ID}/complete`);
    expect(JSON.parse(init.body)).toEqual({ payload_b64: 'QUJD' });
  });
  it('every call asks fetch to error on a redirect, and an id that is not a UUID never becomes a path', async () => {
    const f = answer({ mode: 'off', id: ID, user_code: 'KJ4M-9XQT', expires_at: '2026-10-10T12:00:00.000Z', state: 'pending' });
    vi.stubGlobal('fetch', f);
    const c = client();
    await c.shareRequestsConfig(); await c.stageShareRequest(stageBody); await c.getShareRequest(ID); await c.cancelShareRequest(ID); await c.completeShareRequest(ID, 'QQ==');
    expect(f.mock.calls).toHaveLength(5);
    for (const call of f.mock.calls) expect((call as unknown as [string, { redirect?: string }])[1].redirect).toBe('error');
    for (const bad of ['../auth/me', `${ID}/../x`, '']) await expect(c.getShareRequest(bad)).rejects.toThrow(/not a share request id/);
    expect(f.mock.calls).toHaveLength(5);
  });
});
