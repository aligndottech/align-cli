import { describe, expect, it, vi } from 'vitest';
import { verifyReadOnlyGithubToken } from '../lib/token-scope-gate.js';

const withScopes = (scopes: string | null) =>
  vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: (k: string) => (k.toLowerCase() === 'x-oauth-scopes' ? scopes : null) },
  } as unknown as Response);

/**
 * The reuse gate for tokens found in a local CLI (gh auth token).
 *
 * A pasted token is the user's own deliberate act; a REUSED one is a credential they
 * minted for something else, so it is only taken on positive confirmation that it
 * cannot write. `gh auth login` issues classic tokens carrying `repo`, which is read
 * AND write - the reuse path shipped in #183 was silently holding write capability in
 * the free tier, against ALI-98.
 */
describe('verifyReadOnlyGithubToken', () => {
  it('accepts a token whose every scope is read-only', async () => {
    const r = await verifyReadOnlyGithubToken('t', withScopes('read:org, read:user'));
    expect(r.ok).toBe(true);
  });

  it('accepts a zero-scope token, which can read public data only', async () => {
    const r = await verifyReadOnlyGithubToken('t', withScopes(''));
    expect(r.ok).toBe(true);
  });

  it('refuses a repo-scoped token and names the scope', async () => {
    const r = await verifyReadOnlyGithubToken('t', withScopes('gist, read:org, repo'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('repo');
    // gist is write-capable too and must be named, not just the famous one
    expect(r.reason).toContain('gist');
  });

  it('refuses when the scopes header is absent (fine-grained token, unverifiable)', async () => {
    // A fine-grained PAT reports no X-Oauth-Scopes, so read-only-ness cannot be
    // confirmed. The user can still paste it themselves - that is the same token
    // through the path that carries their deliberate choice.
    const r = await verifyReadOnlyGithubToken('t', withScopes(null));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verify|confirm/i);
  });

  it('refuses on a network failure rather than assuming', async () => {
    const r = await verifyReadOnlyGithubToken('t', vi.fn().mockRejectedValue(new Error('offline')));
    expect(r.ok).toBe(false);
  });

  it('refuses on a non-2xx (revoked or bad token)', async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 401, headers: { get: () => null } });
    const r = await verifyReadOnlyGithubToken('t', bad as unknown as typeof fetch);
    expect(r.ok).toBe(false);
  });

  it('sends the token it is verifying, to the right endpoint', async () => {
    const f = withScopes('read:org');
    await verifyReadOnlyGithubToken('tok-xyz', f);
    const [url, init] = f.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.github.com/user');
    expect(init.headers.Authorization).toBe('Bearer tok-xyz');
  });

  it('is not fooled by whitespace or case in the scope list', async () => {
    const r = await verifyReadOnlyGithubToken('t', withScopes(' READ:ORG ,  Repo '));
    expect(r.ok).toBe(false);
  });
});
