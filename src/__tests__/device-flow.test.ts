import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pollForDeviceToken, requestDeviceCode } from '../lib/device-flow.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const json = (body: unknown, ok = true) =>
  Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });

/**
 * GitHub's device flow, which its docs state needs no client secret:
 * "The `client_secret` is not needed for the device flow."
 *
 * Shape differs from PKCE - there is no redirect at all. The CLI asks for a code,
 * shows the user a short code and a URL, and polls until they approve. That makes it
 * the better fit for a terminal: it works over SSH, in a container, and anywhere a
 * loopback redirect cannot reach a browser. See ALI-778.
 */
describe('requestDeviceCode', () => {
  beforeEach(() => fetchMock.mockReset());

  it('asks for a code with only the client id, never a secret', async () => {
    fetchMock.mockReturnValue(
      json({ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }),
    );
    const r = await requestDeviceCode({
      deviceCodeUrl: 'https://github.com/login/device/code',
      clientId: 'Iv1.public',
      scope: 'read:user',
    });
    expect(r.userCode).toBe('ABCD-1234');
    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(body).toContain('client_id=Iv1.public');
    expect(body).not.toMatch(/client_secret/i);
  });
});

describe('pollForDeviceToken', () => {
  beforeEach(() => fetchMock.mockReset());

  it('returns the token once the user approves', async () => {
    fetchMock.mockReturnValue(json({ access_token: 'gho_ok', token_type: 'bearer' }));
    const r = await pollForDeviceToken({
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: 'Iv1.public',
      deviceCode: 'dev',
      intervalMs: 0,
      expiresAt: Date.now() + 60_000,
    });
    expect(r).toEqual({ ok: true, accessToken: 'gho_ok' });
  });

  it('keeps waiting while the user has not finished, rather than failing', async () => {
    // authorization_pending is the NORMAL state for most of this flow. Treating it
    // as an error would abort the moment polling starts.
    fetchMock
      .mockReturnValueOnce(json({ error: 'authorization_pending' }))
      .mockReturnValueOnce(json({ error: 'authorization_pending' }))
      .mockReturnValue(json({ access_token: 'gho_later' }));
    const r = await pollForDeviceToken({
      tokenUrl: 'https://x/token', clientId: 'c', deviceCode: 'd',
      intervalMs: 0, expiresAt: Date.now() + 60_000,
    });
    expect(r).toEqual({ ok: true, accessToken: 'gho_later' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('backs off when the provider says slow_down, instead of hammering it', async () => {
    fetchMock
      .mockReturnValueOnce(json({ error: 'slow_down', interval: 10 }))
      .mockReturnValue(json({ access_token: 'gho_ok' }));
    const slept: number[] = [];
    const r = await pollForDeviceToken({
      tokenUrl: 'https://x/token', clientId: 'c', deviceCode: 'd',
      intervalMs: 0, expiresAt: Date.now() + 60_000,
      sleepFn: async (ms) => { slept.push(ms); },
    });
    expect(r.ok).toBe(true);
    // The point of the test: it waited LONGER than it was going to, using the
    // interval the provider asked for rather than retrying at the same rate.
    expect(slept.at(-1)).toBe(10_000);
  });

  it('stops on a real refusal and says which one', async () => {
    fetchMock.mockReturnValue(json({ error: 'access_denied' }));
    const r = await pollForDeviceToken({
      tokenUrl: 'https://x/token', clientId: 'c', deviceCode: 'd',
      intervalMs: 0, expiresAt: Date.now() + 60_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('access_denied');
  });

  it('gives up once the code has expired rather than polling forever', async () => {
    fetchMock.mockReturnValue(json({ error: 'authorization_pending' }));
    const r = await pollForDeviceToken({
      tokenUrl: 'https://x/token', clientId: 'c', deviceCode: 'd',
      intervalMs: 0, expiresAt: Date.now() - 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });
});
