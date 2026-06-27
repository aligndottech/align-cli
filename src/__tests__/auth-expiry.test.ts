import { describe, expect, it } from 'vitest';
import { FetcherAuthError } from '@aligndottech/connector-core';
import { AuthExpiredError, isAuthExpiry } from '../lib/errors.js';

// isAuthExpiry decides whether a failed connector fetch means the stored
// credential is expired/revoked (so `align setup` should offer an OAuth
// reconnect) vs. a failure where re-auth would not help. It must recognize
// the typed errors AND the generic Errors that @aligndottech/connector-core
// fetchers throw with the provider status/code baked into the message.
describe('isAuthExpiry', () => {
  it('recognizes the CLI AuthExpiredError (jira/confluence wrappers)', () => {
    expect(isAuthExpiry(new AuthExpiredError('jira'))).toBe(true);
  });

  it('recognizes connector-core FetcherAuthError (401, reconnect helps)', () => {
    expect(isAuthExpiry(new FetcherAuthError('Jira'))).toBe(true);
  });

  // The real connector-core messages observed in a live setup run. Every one of
  // these is an expired/revoked token (HTTP 401) that today is silently skipped
  // because the fetcher throws a generic Error, not AuthExpiredError.
  it.each([
    "GitHub auth failed (401). Check your token has 'repo' scope.",
    "GitLab auth failed (401). Check your token has 'read_api' scope.",
    'Linear API failed (401). Check your personal API token.',
    'Zoom API error 401: Access token is expired.',
    'Microsoft Graph API error 401 on /me/joinedTeams: Lifetime validation failed, the token is expired.',
    'Notion API failed (401). Check your integration token.',
    'Jira API failed (401): unauthorized',
    'Confluence API failed (401). Check your OAuth token.',
  ])('recognizes a generic 401 message: %s', (msg) => {
    expect(isAuthExpiry(new Error(msg))).toBe(true);
  });

  it.each([
    'Slack API error on auth.test: invalid_auth',
    'Slack API error on conversations.list: not_authed',
    'Slack API error on auth.test: token_revoked',
    'Slack API error on auth.test: account_inactive',
  ])('recognizes a Slack auth error code: %s', (msg) => {
    expect(isAuthExpiry(new Error(msg))).toBe(true);
  });

  // Linear's GraphQL API returns its auth failures as HTTP 200 + errors[], so
  // connector-core throws the RAW Linear message (no "401"). These must still be
  // recognized - this was the residual gap a 401-only heuristic missed.
  it.each([
    'Authentication required, not authenticated', // Linear bad/expired API key
    'Authentication token is invalid',
    'Invalid API key',
    'Request unauthorized',
    'You are not authenticated',
  ])('recognizes a worded auth-expiry message (no status code): %s', (msg) => {
    expect(isAuthExpiry(new Error(msg))).toBe(true);
  });

  // 403 = missing scopes: re-auth with the same consent will not help, so
  // connector-core deliberately keeps it a generic error. We must NOT offer a
  // futile reconnect for it. Same for any non-auth failure.
  it.each([
    "GitHub auth failed (403). Check your token has 'repo' scope.",
    'GitLab auth failed (404). Not found.',
    'Notion API failed (500). Server error.',
    'Could not resolve author name', // "author" must not trip the auth heuristic
    'Rate limited (429). Try again later.',
    'fetch failed',
    'boom',
    '',
  ])('does NOT treat a non-401/non-auth failure as expiry: %s', (msg) => {
    expect(isAuthExpiry(new Error(msg))).toBe(false);
  });

  it('returns false for non-Error values (only Error.message is inspected)', () => {
    expect(isAuthExpiry(null)).toBe(false);
    expect(isAuthExpiry(undefined)).toBe(false);
    expect(isAuthExpiry(401)).toBe(false);
    expect(isAuthExpiry('401')).toBe(false);
  });
});