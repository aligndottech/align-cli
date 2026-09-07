import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ALI-917: resolveGitHubRepoScope is the one place that decides which repo (if any) to
 * scope a GitHub fetch to - shared by `align import github` (which has --repo/--all) and
 * `align setup`'s interactive GitHub source (which has neither, and calls this with {}).
 *
 * Test List:
 * 1. --all wins outright, even with a detected github.com repo
 * 2. --repo names one explicitly, without ever calling currentRepoIdentity
 * 3. neither flag: auto-detects from a github.com remote
 * 4. neither flag, no git repo at all: unscoped (undefined, not an empty string)
 * 5. neither flag, a non-github remote (gitlab, or a bare local path fallback): unscoped -
 *    GitHub's repo: qualifier cannot use either shape
 */

const currentRepoIdentity = vi.hoisted(() => vi.fn());
vi.mock('../../lib/repo-identity.js', () => ({ currentRepoIdentity }));

const { resolveGitHubRepoScope } = await import('../../lib/fetchers/github.js');

describe('resolveGitHubRepoScope', () => {
  beforeEach(() => currentRepoIdentity.mockReset());

  it('--all wins outright, even over a detected github.com repo', async () => {
    currentRepoIdentity.mockResolvedValue('github.com/o/r');
    expect(await resolveGitHubRepoScope({ all: true })).toBeUndefined();
    expect(currentRepoIdentity).not.toHaveBeenCalled();
  });

  it('--repo names one explicitly, without consulting git at all', async () => {
    expect(await resolveGitHubRepoScope({ repo: 'someone-else/other-repo' })).toBe('someone-else/other-repo');
    expect(currentRepoIdentity).not.toHaveBeenCalled();
  });

  it('auto-detects from a github.com remote when neither flag is given', async () => {
    currentRepoIdentity.mockResolvedValue('github.com/doitintl/kube-no-trouble');
    expect(await resolveGitHubRepoScope({})).toBe('doitintl/kube-no-trouble');
  });

  it('is unscoped outside a git repo', async () => {
    currentRepoIdentity.mockResolvedValue(null);
    expect(await resolveGitHubRepoScope({})).toBeUndefined();
  });

  it('is unscoped when the detected identity is not a github.com repo', async () => {
    currentRepoIdentity.mockResolvedValue('gitlab.com/o/r');
    expect(await resolveGitHubRepoScope({})).toBeUndefined();
    currentRepoIdentity.mockResolvedValue('/home/user/some-local-only-repo');
    expect(await resolveGitHubRepoScope({})).toBeUndefined();
  });
});
