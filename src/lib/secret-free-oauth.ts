/**
 * Which connectors can authenticate with NO client secret, and how.
 *
 * True local mode must make no hosted call (ALI-778). Today's connector OAuth
 * routes through the gateway solely because the gateway holds each provider's
 * client_secret, and a secret inside a distributed binary is not a secret. Device
 * flow and PKCE remove that need entirely.
 *
 * The membership of this map is a CLAIM ABOUT PROVIDERS, verified against their
 * docs rather than assumed:
 *
 *   github  device flow  "The client_secret is not needed for the device flow."
 *   gitlab  PKCE         "...without requiring access to the Client Secret at all."
 *   linear  PKCE         code_challenge + code_challenge_method=S256 documented
 *   zoom    PKCE         "a separate public client ID ... doesn't require a secret"
 *
 * Notion and Atlassian are ABSENT ON PURPOSE and must stay absent. Notion's token
 * exchange is HTTP Basic with CLIENT_ID:CLIENT_SECRET; Atlassian 3LO requires
 * client_secret and documents no PKCE. Adding either here would ship a flow that
 * cannot complete.
 */

import { type PublicClientId, resolveClientId } from './public-client-ids.js';

export type SecretFreeKind = 'device' | 'pkce';

export interface SecretFreeConfig {
  kind: SecretFreeKind;
  /**
   * Whether the token this flow yields can WRITE. False for every flow shipped here,
   * and asserted as such by a test - ALI-94 / ALI-98: the free, CLI and personal tier
   * never holds write capability. Modelled rather than assumed so that adding a
   * write-capable provider is a visible, deliberate act rather than a silent one.
   */
  writeCapable?: boolean;
  // The client id itself lives in public-client-ids.ts, which owns both the committed
  // value and the name of the env var that overrides it. Naming it here too made this
  // config the second writer of one fact, and the field went dead the moment the
  // resolver stopped reading it.
  authorizeUrl?: string;
  deviceCodeUrl?: string;
  tokenUrl: string;
  /**
   * Read-only. ALI-94 / ALI-98: the personal and CLI tier never holds write.
   *
   * Sent in the authorize URL for a PKCE flow, and in the device-code POST body for a
   * device flow - so it is not, as this file once said of the client id, something
   * that "appears in every authorize URL". GitHub has no authorize URL at all.
   */
  scope: string;
  extra?: Record<string, string>;
}

export const SECRET_FREE_CONNECTORS: Record<string, SecretFreeConfig> = {
  // The read-only GitHub APP, and the ONLY GitHub path - #195 removed the OAuth
  // alternative and its prompt, so there is nothing to choose between. Its `scope` is
  // deliberately empty - a GitHub App's user-to-server
  // access is governed by the App's configured permissions and the scope is IGNORED.
  // #194 shipped OAuth-style scopes here, which did nothing and implied a control
  // that was not there; the real guarantee is Contents/Issues/PRs: Read on the App.
  github: {
    kind: 'device',
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: '',
    writeCapable: false,
  },
  gitlab: {
    kind: 'pkce',
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    // read_api, never `api` - the latter grants write. See ALI-98.
    scope: 'read_api',
  },
  linear: {
    kind: 'pkce',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scope: 'read',
  },
  zoom: {
    kind: 'pkce',
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    scope: 'recording:read',
  },
};

export function supportsSecretFreeOAuth(connectorId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SECRET_FREE_CONNECTORS, connectorId);
}

export interface PkceExchangeRequest {
  tokenUrl: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
}

export type ExchangeResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: string };

export async function exchangePkceCode(req: PkceExchangeRequest): Promise<ExchangeResult> {
  // No Authorization header, deliberately. Zoom's docs call this out: "Unlike the
  // confidential client flow, PKCE does not use an Authorization header." Sending
  // one turns this into a confidential exchange, which a public client id refuses.
  const res = await fetch(req.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: req.clientId,
      code: req.code,
      redirect_uri: req.redirectUri,
      code_verifier: req.verifier,
    }).toString(),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && typeof body['access_token'] === 'string') {
    return { ok: true, accessToken: body['access_token'] };
  }
  const err = String(body['error'] ?? res.status);
  const desc = body['error_description'] ? `: ${String(body['error_description'])}` : '';
  return { ok: false, reason: `${err}${desc}` };
}

/**
 * Can we actually run a secret-free sign-in for this connector, here, today?
 *
 * `supportsSecretFreeOAuth` answers whether the PROVIDER offers one, which is a
 * permanent fact about their design. This answers whether we can use it, which also
 * needs a public client id we have shipped. Keeping them apart is what lets the CLI
 * give the user the true reason for a token paste instead of a plausible one.
 */
export function canRunSecretFreeOAuth(
  connectorId: string,
  env?: Record<string, string | undefined>,
  ids?: Record<string, PublicClientId>,
): boolean {
  if (!supportsSecretFreeOAuth(connectorId)) return false;
  return resolveClientId(connectorId, env, ids) !== null;
}
