import { FetcherAuthError } from '@aligndottech/connector-core';

export class AuthExpiredError extends Error {
  constructor(public readonly source: string) {
    super(`${source} token expired or revoked. Run: align setup to reconnect.`);
    this.name = 'AuthExpiredError';
  }
}

// Signals that a connector fetch failed because the stored credential is expired
// or revoked. Only the CLI's jira/confluence fetchers throw the typed
// AuthExpiredError; the other connector-core fetchers throw a generic Error that
// carries the provider's auth signal in the message - an HTTP 401, a Slack
// data.error code, or (Linear's GraphQL, which 401s as HTTP 200 + errors[]) a
// worded message like "Authentication required, not authenticated".
//
// Deliberately NOT matched: HTTP 403 / "missing scope" (re-consenting with the
// same scopes won't help - those stay in the "skipped, run align import later"
// path), and the bare connector-core "<x> auth failed (404/500)" phrasing, which
// uses "auth" not "authentication".
const AUTH_EXPIRY_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\bunauthori[sz]ed\b/,
  /\bunauthenticated\b/,
  /\bnot authenticated\b/,
  /\bauthentication (required|failed|expired)\b/,
  /\binvalid api key\b/,
  /\btoken (is )?(invalid|expired|revoked)\b/,
  /\b(invalid_auth|not_authed|token_revoked|token_expired|account_inactive)\b/,
];

/**
 * True when a failed connector fetch means the stored credential is expired or
 * revoked, so `align setup` should offer an OAuth reconnect rather than silently
 * skipping the connector. Recognizing the various provider phrasings keeps the
 * reconnect prompt working for every connector without a connector-core release.
 *
 * Only consulted in the OAuth setup path (gated on source.oauthKey), so it never
 * changes the manual `align import <x> --token` error text.
 */
export function isAuthExpiry(err: unknown): boolean {
  if (err instanceof AuthExpiredError || err instanceof FetcherAuthError) return true;
  const msg = (err instanceof Error ? err.message : '').toLowerCase();
  return msg.length > 0 && AUTH_EXPIRY_PATTERNS.some((re) => re.test(msg));
}