import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => vi.fn<() => string | null>());
vi.mock('../lib/repo-identity.js', async (orig) => ({ ...(await orig<object>()), currentRepoIdentitySync: identity }));

import { scopeRepoKey, SYNC_REPO_ENV } from '../lib/scope-real.js';

/**
 * scopeRepoKey runs git, and a scope read asks for it once per source. Within one process and one directory the answer does not
 * change, so it is asked once, including a "not a repo" answer. A repo handed in by the environment never touches git or the cache.
 */
let cwd: ReturnType<typeof vi.spyOn>;
let here = '/work/a';
beforeEach(() => { identity.mockReset(); cwd = vi.spyOn(process, 'cwd').mockImplementation(() => here); here = '/work/a'; });
afterEach(() => cwd.mockRestore());

describe('scopeRepoKey', () => {
  it('asks git once per directory however many times it is read', () => {
    identity.mockReturnValue('github.com/acme/api');
    expect([scopeRepoKey({}), scopeRepoKey({}), scopeRepoKey({})]).toEqual(Array(3).fill('github.com/acme/api'));
    expect(identity).toHaveBeenCalledTimes(1);
  });

  it('a null (not a repo, or a timeout) is asked again, and another directory is asked separately', () => {
    here = '/work/plain';
    identity.mockReturnValue(null);
    expect([scopeRepoKey({}), scopeRepoKey({})]).toEqual([null, null]);
    expect(identity).toHaveBeenCalledTimes(2);
    identity.mockClear();
    here = '/work/b';
    identity.mockReturnValue('github.com/acme/web');
    expect(scopeRepoKey({})).toBe('github.com/acme/web');
    expect(identity).toHaveBeenCalledTimes(1);
  });

  it('a non-empty SYNC_REPO_ENV is returned directly, without git and without touching the cache; empty or unset is not', () => {
    here = '/work/env';
    identity.mockReturnValue('github.com/acme/real');
    expect(scopeRepoKey({ [SYNC_REPO_ENV]: 'github.com/acme/given' })).toBe('github.com/acme/given');
    expect(identity).not.toHaveBeenCalled();
    expect(scopeRepoKey({ [SYNC_REPO_ENV]: '' })).toBe('github.com/acme/real');
    expect(scopeRepoKey({})).toBe('github.com/acme/real');
    expect(identity).toHaveBeenCalledTimes(1);
  });
});
