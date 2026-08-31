import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangePkceCode, SECRET_FREE_CONNECTORS, supportsSecretFreeOAuth } from '../lib/secret-free-oauth.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('exchangePkceCode', () => {
  beforeEach(() => fetchMock.mockReset());

  it('sends the verifier and NO client secret', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ access_token: 'tok' }) });
    const r = await exchangePkceCode({
      tokenUrl: 'https://gitlab.com/oauth/token',
      clientId: 'public-123',
      code: 'code-abc',
      verifier: 'ver-xyz',
      redirectUri: 'http://127.0.0.1:7654/callback',
    });
    expect(r).toEqual({ ok: true, accessToken: 'tok' });
    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(body).toContain('code_verifier=ver-xyz');
    expect(body).not.toMatch(/client_secret/i);
  });

  it('sends no Authorization header, which is what distinguishes the public flow', async () => {
    // Zoom's docs are explicit: "Unlike the confidential client flow, PKCE does not
    // use an Authorization header." Sending one would make it a confidential
    // exchange and fail against a public client id.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ access_token: 't' }) });
    await exchangePkceCode({
      tokenUrl: 'https://zoom.us/oauth/token', clientId: 'c', code: 'x',
      verifier: 'v', redirectUri: 'http://127.0.0.1:7654/callback',
    });
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('reports a refusal instead of throwing a raw fetch error', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 401,
      json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'verifier mismatch' }),
    });
    const r = await exchangePkceCode({
      tokenUrl: 'https://x/token', clientId: 'c', code: 'x', verifier: 'v',
      redirectUri: 'http://127.0.0.1:7654/callback',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid_grant/);
  });
});

describe('SECRET_FREE_CONNECTORS', () => {
  it('covers exactly the connectors whose providers support a secret-free flow', () => {
    // Verified against provider docs in ALI-778. Notion and Atlassian mandate a
    // client secret on exchange, so they are deliberately absent and must stay so:
    // adding them would produce a flow that cannot work.
    expect(Object.keys(SECRET_FREE_CONNECTORS).sort()).toEqual(['github', 'gitlab', 'linear', 'zoom']);
  });

  it('does NOT claim support for the ones that mandate a secret', () => {
    for (const id of ['notion', 'jira', 'confluence', 'slack', 'teams']) {
      expect(supportsSecretFreeOAuth(id)).toBe(false);
    }
  });

  it('uses device flow for GitHub and PKCE for the rest', () => {
    expect(SECRET_FREE_CONNECTORS['github']?.kind).toBe('device');
    for (const id of ['gitlab', 'linear', 'zoom']) {
      expect(SECRET_FREE_CONNECTORS[id]?.kind).toBe('pkce');
    }
  });

  it('requests read-only scopes only', () => {
    // ALI-94 / ALI-98: the personal + CLI tier must never hold write capability.
    for (const [id, cfg] of Object.entries(SECRET_FREE_CONNECTORS)) {
      expect(cfg.scope, `${id} scope`).not.toMatch(/\bwrite\b|\badmin\b|\bdelete\b/i);
    }
  });
});

describe('the read-only invariant (ALI-94 / ALI-98)', () => {
  // The decision this file is governed by: the free, CLI and personal tier must
  // never hold write capability. PR #195 originally shipped a user-selectable
  // write-capable GitHub path here and the decision graph flagged it as a conflict.
  // It was dropped rather than superseded, and this is what keeps it dropped - a
  // comment cannot fail, and the last one describing this had already gone stale.
  it('ships no write-capable flow', () => {
    const writable = Object.entries(SECRET_FREE_CONNECTORS)
      .filter(([, cfg]) => cfg.writeCapable)
      .map(([id]) => id);
    expect(writable).toEqual([]);
  });

  it('names a scope for every flow that uses one, and none that can write', () => {
    // Positive control: prove the map is populated before asserting over it, or an
    // empty map passes both of these vacuously.
    const ids = Object.keys(SECRET_FREE_CONNECTORS);
    expect(ids.length).toBeGreaterThan(0);

    for (const [id, cfg] of Object.entries(SECRET_FREE_CONNECTORS)) {
      // GitHub Apps IGNORE scope - permissions live on the App - so empty is correct
      // there and would be a defect anywhere else.
      if (id === 'github') { expect(cfg.scope).toBe(''); continue; }
      expect(cfg.scope, `${id} must declare a scope`).not.toBe('');
      expect(cfg.scope, `${id} scope must not grant write`).not.toMatch(/\b(write|api|admin)\b/);
    }
  });
});
