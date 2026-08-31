import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636) and the pieces of an authorization request that do not need a
 * client secret.
 *
 * WHY THIS EXISTS
 * ---------------
 * True local mode must make no hosted call. Today's connector OAuth cannot manage
 * that: `collectTokensViaOAuth` asks the gateway to start the flow, because the
 * gateway is where each provider's `client_secret` lives. A secret shipped inside a
 * distributed binary is not a secret, so the CLI cannot simply carry one.
 *
 * PKCE removes the need for one. Instead of a long-lived shared secret proving "this
 * is Align", a fresh random `verifier` is generated per authorization, its SHA-256
 * sent up front as the `challenge`, and the original presented at exchange time. An
 * attacker who intercepts the authorization code cannot use it without the verifier,
 * which never leaves this machine.
 *
 * This is the standard pattern for CLIs - `aws sso login`, `gcloud auth login` and
 * `az login` all work this way, and RFC 8252 tells native apps to do exactly this
 * with a loopback redirect. See ALI-778.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * A fresh verifier/challenge pair.
 *
 * 32 random bytes base64url-encoded gives 43 characters, the minimum RFC 7636
 * allows and ample entropy. base64url is used rather than base64 so the value needs
 * no escaping in a query string - a `+` or `/` would be mangled in transit and the
 * exchange would fail with an error naming nothing useful.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // Never 'plain': it sends the verifier unhashed, so intercepting the authorize
  // request hands over the very value the exchange is meant to prove you hold.
  return { verifier, challenge, method: 'S256' };
}

export interface AuthorizeUrlOptions {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  /**
   * Provider-specific extras appended to the authorize URL. Unused today: no entry
   * in SECRET_FREE_CONNECTORS sets it. The example here used to be Notion's
   * `owner=user`, which is the one connector that must never reach this code - its
   * exchange is HTTP Basic with a client secret, so it has no PKCE flow to extend.
   */
  extra?: Record<string, string>;
}

/**
 * Build the authorize URL, preserving any query the provider already put on it.
 *
 * Parsed and appended to rather than rebuilt: several providers publish authorize
 * URLs that already carry required parameters, and constructing a fresh URL would
 * drop them silently.
 */
export function buildAuthorizeUrl(opts: AuthorizeUrlOptions): string {
  const url = new URL(opts.authorizeUrl);
  const p = url.searchParams;
  p.set('client_id', opts.clientId);
  p.set('redirect_uri', opts.redirectUri);
  p.set('response_type', 'code');
  p.set('scope', opts.scope);
  p.set('state', opts.state);
  p.set('code_challenge', opts.challenge);
  p.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(opts.extra ?? {})) p.set(k, v);
  return url.toString();
}
