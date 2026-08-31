/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628), as GitHub implements it.
 *
 * GitHub's docs are explicit that this needs no secret: "The `client_secret` is not
 * needed for the device flow." That is what lets true local mode authenticate with
 * no hosted call - see ALI-778 and lib/pkce.ts for the same argument.
 *
 * Shape differs from PKCE in a way that suits a terminal better: there is no
 * redirect at all. The CLI shows a short code and a URL, the user approves in
 * whatever browser they like, and the CLI polls. That works over SSH, inside a
 * container, and anywhere a loopback redirect cannot reach a browser.
 *
 * NOTE: device flow must be enabled per-app in GitHub's settings. It is off by
 * default and the code request fails until it is on.
 */

export interface DeviceCodeRequest {
  deviceCodeUrl: string;
  clientId: string;
  scope: string;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
}

export async function requestDeviceCode(req: DeviceCodeRequest): Promise<DeviceCodeResponse> {
  const res = await fetch(req.deviceCodeUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: req.clientId, scope: req.scope }).toString(),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof body['device_code'] !== 'string') {
    // The likeliest cause by far, so name it rather than echoing a bare error code:
    // device flow is opt-in per app and silently absent until enabled.
    throw new Error(
      `Could not start the device flow (${String(body['error'] ?? res.status)}). ` +
      'If this app has never used it, enable Device Flow in its settings.',
    );
  }
  const intervalSec = typeof body['interval'] === 'number' ? body['interval'] : 5;
  const expiresSec = typeof body['expires_in'] === 'number' ? body['expires_in'] : 900;
  return {
    deviceCode: String(body['device_code']),
    userCode: String(body['user_code'] ?? ''),
    verificationUri: String(body['verification_uri'] ?? ''),
    intervalMs: intervalSec * 1000,
    expiresAt: Date.now() + expiresSec * 1000,
  };
}

export interface DevicePollRequest {
  tokenUrl: string;
  clientId: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  /**
   * Injectable so a test can drive the retry logic without real time passing.
   * Without it the slow_down path genuinely sleeps for the provider's interval,
   * which is right in production and untestable in a suite.
   */
  sleepFn?: (ms: number) => Promise<void>;
}

export type DevicePollResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pollForDeviceToken(req: DevicePollRequest): Promise<DevicePollResult> {
  const pause = req.sleepFn ?? sleep;
  let interval = req.intervalMs;
  for (;;) {
    if (Date.now() > req.expiresAt) return { ok: false, reason: 'expired' };

    const res = await fetch(req.tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: req.clientId,
        device_code: req.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    const body = (await res.json()) as Record<string, unknown>;

    if (typeof body['access_token'] === 'string') {
      return { ok: true, accessToken: body['access_token'] };
    }

    const error = String(body['error'] ?? 'unknown_error');
    // Per RFC 8628 these two are not failures - they are the flow working. Most of a
    // device flow's life is spent in authorization_pending while the user reads the
    // screen, so treating it as an error would abort immediately.
    if (error === 'authorization_pending') {
      await pause(interval);
      continue;
    }
    if (error === 'slow_down') {
      // The provider is telling us our interval is too tight. Honour its number when
      // given one, rather than retrying at the same rate and being throttled harder.
      const bumped = typeof body['interval'] === 'number' ? body['interval'] * 1000 : interval + 5000;
      interval = bumped;
      await pause(interval);
      continue;
    }
    return { ok: false, reason: error };
  }
}
