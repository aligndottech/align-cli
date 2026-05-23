import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { buildCommitUrl, formatCommitAsText, getCurrentBranch, getHeadDiff, getStagedDiff, isDecisionCommit, isGitRepo } from '../lib/git.js';
import type { GitCommit } from '../lib/git.js';

describe('git helpers', () => {
  it('getStagedDiff returns staged diff', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'diff --git a/file.ts', stderr: '' } as Awaited<ReturnType<typeof execa>>);
    const diff = await getStagedDiff();
    expect(diff).toBe('diff --git a/file.ts');
  });

  it('getHeadDiff returns HEAD diff', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'diff --git b/other.ts', stderr: '' } as Awaited<ReturnType<typeof execa>>);
    const diff = await getHeadDiff();
    expect(diff).toBe('diff --git b/other.ts');
  });

  it('getCurrentBranch returns trimmed branch name', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'feat/my-feature\n', stderr: '' } as Awaited<ReturnType<typeof execa>>);
    const branch = await getCurrentBranch();
    expect(branch).toBe('feat/my-feature');
  });

  it('isGitRepo returns false when not in a repo', async () => {
    vi.mocked(execa).mockRejectedValueOnce(new Error('not a repo'));
    expect(await isGitRepo()).toBe(false);
  });

  it('isGitRepo returns true when in a repo', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: '.git', stderr: '' } as Awaited<ReturnType<typeof execa>>);
    expect(await isGitRepo()).toBe(true);
  });
});

describe('buildCommitUrl', () => {
  it('builds GitHub URL from SSH remote', () => {
    const url = buildCommitUrl('git@github.com:org/repo.git', 'abc123');
    expect(url).toBe('https://github.com/org/repo/commit/abc123');
  });

  it('builds GitHub URL from HTTPS remote', () => {
    const url = buildCommitUrl('https://github.com/org/repo.git', 'abc123');
    expect(url).toBe('https://github.com/org/repo/commit/abc123');
  });

  it('builds GitLab URL from HTTPS remote', () => {
    const url = buildCommitUrl('https://gitlab.com/org/repo.git', 'def456');
    expect(url).toBe('https://gitlab.com/org/repo/-/commit/def456');
  });

  it('falls back to git:// scheme when remote is null', () => {
    const url = buildCommitUrl(null, 'abc123');
    expect(url).toBe('git://commit/abc123');
  });

  it('falls back to git:// scheme for unknown remotes', () => {
    const url = buildCommitUrl('https://bitbucket.org/org/repo.git', 'abc123');
    expect(url).toBe('git://commit/abc123');
  });
});

describe('isDecisionCommit', () => {
  it('rejects subjects shorter than 20 chars', () => {
    expect(isDecisionCommit('fix typo')).toBe(false);
  });

  it('rejects subjects starting with fix:', () => {
    expect(isDecisionCommit('fix: correct null check in auth middleware')).toBe(false);
  });

  it('rejects subjects starting with chore:', () => {
    expect(isDecisionCommit('chore: update dependencies to latest')).toBe(false);
  });

  it('rejects subjects starting with wip', () => {
    expect(isDecisionCommit('wip working on the new auth flow')).toBe(false);
  });

  it('accepts meaningful decision commits', () => {
    expect(isDecisionCommit('feat(auth): add API token authentication system')).toBe(true);
    expect(isDecisionCommit('Migrate from REST to GraphQL for client queries')).toBe(true);
    expect(isDecisionCommit('Switch database from Postgres to CockroachDB')).toBe(true);
  });
});

describe('formatCommitAsText', () => {
  const commit: GitCommit = {
    sha: 'abc123',
    subject: 'Add JWT authentication',
    body: 'Replaces session tokens with stateless JWTs.',
    author: 'Tom',
    date: '2026-05-01T10:00:00Z',
    filesChanged: ['src/auth.ts', 'src/middleware.ts'],
  };

  it('includes subject, author, date and files', () => {
    const text = formatCommitAsText(commit);
    expect(text).toContain('Add JWT authentication');
    expect(text).toContain('Author: Tom');
    expect(text).toContain('Date: 2026-05-01T10:00:00Z');
    expect(text).toContain('src/auth.ts');
  });

  it('includes URL when provided', () => {
    const text = formatCommitAsText(commit, 'https://github.com/org/repo/commit/abc123');
    expect(text).toContain('URL: https://github.com/org/repo/commit/abc123');
  });

  it('includes body when present', () => {
    const text = formatCommitAsText(commit);
    expect(text).toContain('Replaces session tokens with stateless JWTs.');
  });
});
