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

export type SecretFreeKind = 'device' | 'pkce';

export interface SecretFreeConfig {
  kind: SecretFreeKind;
  /**
   * Whether the token this flow yields can WRITE. False everywhere except GitHub's
   * OAuth App fallback, where classic OAuth's `repo` scope is read+write and no
   * read-only-private equivalent exists. Surfaced so the CLI can disclose it: ALI-98
   * permits a write-capable token in true local, but never a silent one.
   */
  writeCapable?: boolean;
  /** Public client id. Not a secret - it appears in every authorize URL. */
  clientIdEnv: string;
  authorizeUrl?: string;
  deviceCodeUrl?: string;
  tokenUrl: string;
  /** Read-only. ALI-94 / ALI-98: the personal and CLI tier never holds write. */
  scope: string;
  extra?: Record<string, string>;
}

export const SECRET_FREE_CONNECTORS: Record<string, SecretFreeConfig> = {
  // The read-only GitHub APP. Default on purpose: the safe path is what you get by
  // not choosing. Its `scope` is deliberately empty - a GitHub App's user-to-server
  // access is governed by the App's configured permissions and the scope is IGNORED.
  // #194 shipped OAuth-style scopes here, which did nothing and implied a control
  // that was not there; the real guarantee is Contents/Issues/PRs: Read on the App.
  github: {
    kind: 'device',
    clientIdEnv: 'ALIGN_GITHUB_APP_PUBLIC_CLIENT_ID',
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: '',
    writeCapable: false,
  },
  gitlab: {
    kind: 'pkce',
    clientIdEnv: 'ALIGN_GITLAB_PUBLIC_CLIENT_ID',
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    // read_api, never `api` - the latter grants write. See ALI-98.
    scope: 'read_api',
  },
  linear: {
    kind: 'pkce',
    clientIdEnv: 'ALIGN_LINEAR_PUBLIC_CLIENT_ID',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scope: 'read',
  },
  zoom: {
    kind: 'pkce',
    clientIdEnv: 'ALIGN_ZOOM_PUBLIC_CLIENT_ID',
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


export interface GithubVariant {
  id: 'github-app' | 'github-oauth';
  label: string;
  kind: SecretFreeKind;
  clientIdEnv: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scope: string;
  writeCapable: boolean;
  /** Stated to the user before they choose. Empty for the recommended path. */
  tradeoff: string;
}

/**
 * The two ways to sign in to GitHub from true local, in recommended order.
 *
 * These are not interchangeable and the difference is not cosmetic:
 *
 *   App    genuinely read-only, but must be INSTALLED, and GitHub's docs say "the
 *          user or organization owner who installed the app can decide what
 *          repositories the app can access". On an org the user does not own, that
 *          is someone else's veto - the exact dependency true local exists to avoid.
 *   OAuth  no installation, "can access every repository that the user who
 *          authorized the app can access", but `repo` is read AND write because
 *          classic OAuth has no read-only-private scope.
 *
 * Shipping both is permitted by ALI-98 as amended 2026-08-31. Its actual prohibition
 * is on a SILENT fallback, which is why `tradeoff` is not optional here.
 */
export function githubVariants(): GithubVariant[] {
  return [
    {
      id: 'github-app',
      label: 'GitHub App (read-only)',
      kind: 'device',
      clientIdEnv: 'ALIGN_GITHUB_APP_PUBLIC_CLIENT_ID',
      deviceCodeUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      // Ignored for a GitHub App - permissions govern. Empty rather than a
      // plausible-looking scope string that does nothing.
      scope: '',
      writeCapable: false,
      tradeoff: '',
    },
    {
      id: 'github-oauth',
      label: 'GitHub OAuth (no install needed)',
      kind: 'device',
      clientIdEnv: 'ALIGN_GITHUB_OAUTH_PUBLIC_CLIENT_ID',
      deviceCodeUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      // `repo` covers private repositories. It is read AND write; there is no
      // read-only-private alternative in classic OAuth, which is the whole reason
      // this variant carries a warning.
      scope: 'read:user repo',
      writeCapable: true,
      tradeoff:
        'needs no install or owner approval, but the token it creates can write as well as read',
    },
  ];
}
