/**
 * Positive read-only verification for tokens REUSED from a local CLI.
 *
 * A pasted token is the user's own deliberate act, scoped by them at mint time. A
 * reused one (gh auth token) is a credential they minted for something else, so it is
 * taken only on positive confirmation that it cannot write. `gh auth login` issues
 * classic tokens carrying `repo` - read AND write, with no read-only-private
 * equivalent - so the ungated reuse shipped in #183 was quietly holding write
 * capability in the free tier, against ALI-98.
 *
 * Every refusal falls through to the paste prompt, so the user is never blocked; the
 * gate only decides whether a credential is taken WITHOUT them minting one.
 */

export interface ScopeVerdict {
  ok: boolean;
  /** Present on refusal: names the offending scopes, or why we could not tell. */
  reason?: string;
}

/**
 * A classic scope is read-only iff it matches read:<area>, plus user:email which is
 * read despite its shape. An ALLOWLIST, deliberately: GitHub adds scopes over time,
 * and an unknown scope must refuse, not pass. The famous write-capable ones (repo,
 * public_repo, gist, workflow, admin:*, write:*, delete:*) all fail this test, and so
 * does anything we have never heard of.
 */
const READ_ONLY_SCOPE = /^read:[a-z_]+$/;
const READ_ONLY_EXCEPTIONS = new Set(['user:email']);

function isReadOnlyScope(scope: string): boolean {
  return READ_ONLY_SCOPE.test(scope) || READ_ONLY_EXCEPTIONS.has(scope);
}

export async function verifyReadOnlyGithubToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<ScopeVerdict> {
  let header: string | null;
  try {
    const res = await fetchFn('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return { ok: false, reason: `GitHub rejected the token (HTTP ${res.status})` };
    header = res.headers.get('x-oauth-scopes');
  } catch {
    // Refuse, do not assume: this gate exists to grant a convenience, and "could not
    // check" must not become "checked out fine". The paste path remains.
    return { ok: false, reason: 'could not verify the token with GitHub' };
  }

  // Fine-grained PATs report no scopes header at all, so read-only-ness cannot be
  // confirmed from outside. Distinct from an EMPTY header, which is a classic token
  // with zero scopes: that one can read public data only, and is fine.
  if (header === null) {
    return { ok: false, reason: 'could not confirm the token is read-only (no scope list)' };
  }

  const scopes = header
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const writeCapable = scopes.filter((s) => !isReadOnlyScope(s));
  if (writeCapable.length > 0) {
    return { ok: false, reason: `token can write (scopes: ${writeCapable.join(', ')})` };
  }
  return { ok: true };
}
