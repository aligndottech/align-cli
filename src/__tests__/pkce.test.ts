import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildAuthorizeUrl, createPkcePair } from '../lib/pkce.js';

/**
 * PKCE (RFC 7636) replaces a shipped client secret with a per-authorization random
 * value. That is what lets true local mode do real OAuth with NO hosted call: the
 * gateway exists today only to hold each provider's client_secret, and a secret
 * inside a distributed binary is not a secret. See ALI-778.
 */
describe('createPkcePair', () => {
  it('derives the challenge as base64url(sha256(verifier)), per RFC 7636', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('declares S256, never plain', () => {
    // The `plain` method passes the verifier through unhashed, which defeats the
    // point: anyone who intercepts the authorize request has the verifier.
    expect(createPkcePair().method).toBe('S256');
  });

  it('is unguessable and fresh on every call', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    // RFC 7636 requires 43-128 characters of entropy.
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.verifier.length).toBeLessThanOrEqual(128);
  });

  it('uses only unreserved URL characters, so it survives a query string intact', () => {
    // base64url output must not need escaping; a `+` or `/` would be mangled in transit
    // and the exchange would fail with an error that names nothing useful.
    expect(createPkcePair().verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe('buildAuthorizeUrl', () => {
  const base = {
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    clientId: 'public-client-123',
    redirectUri: 'http://127.0.0.1:7654/callback',
    scope: 'read_api',
    state: 'nonce-abc',
    challenge: 'chal-xyz',
  };

  it('carries the PKCE challenge and method', () => {
    const u = new URL(buildAuthorizeUrl(base));
    expect(u.searchParams.get('code_challenge')).toBe('chal-xyz');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('never puts a client secret in the URL', () => {
    // The whole point. A secret in an authorize URL would be visible in the browser
    // bar, in history, and in any proxy log.
    expect(buildAuthorizeUrl(base)).not.toMatch(/client_secret/i);
  });

  it('requests an authorization code against the loopback redirect', () => {
    const u = new URL(buildAuthorizeUrl(base));
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:7654/callback');
    expect(u.searchParams.get('state')).toBe('nonce-abc');
  });

  it('preserves query parameters the provider already put on the authorize URL', () => {
    // Notion-style authorize URLs carry their own params (owner=user). Rebuilding the
    // URL from scratch would silently drop them.
    const u = new URL(
      buildAuthorizeUrl({ ...base, authorizeUrl: 'https://example.com/auth?owner=user' }),
    );
    expect(u.searchParams.get('owner')).toBe('user');
    expect(u.searchParams.get('code_challenge')).toBe('chal-xyz');
  });
});
