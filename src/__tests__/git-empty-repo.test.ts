import { afterEach, describe, expect, it, vi } from 'vitest';

const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));

import { getCommitHistory } from '../lib/git.js';

// Regression: `align import git` (the zero-config, no-token first-run "wow") crashed
// with a raw execa stack trace on an empty repo, because `git log` exits 128 on a
// freshly `git init`'d repo with no commits. getCommitHistory must return [] so the
// command degrades to "0 commits found" instead of crashing.
describe('getCommitHistory on an empty repo (no commits yet)', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns [] instead of throwing when git log fails on an empty repo (exit 128)', async () => {
    const err = Object.assign(new Error('Command failed with exit code 128'), {
      exitCode: 128,
      stderr: "fatal: your current branch 'main' does not have any commits yet",
    });
    mockExeca.mockRejectedValueOnce(err);
    await expect(getCommitHistory({ limit: 10 })).resolves.toEqual([]);
  });

  it('still parses commits when git log succeeds', async () => {
    const SEP = '\x1f';
    mockExeca.mockResolvedValueOnce({
      stdout: `COMMIT${SEP}abc123${SEP}Adopt PostgreSQL for the decision store${SEP}Tom${SEP}2026-01-01\nsrc/db.ts`,
    });
    const commits = await getCommitHistory({ limit: 10 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ sha: 'abc123', subject: 'Adopt PostgreSQL for the decision store', author: 'Tom' });
  });

  it('rethrows non-empty-repo git failures (does not silently swallow real errors)', async () => {
    const err = Object.assign(new Error('Command failed with exit code 128'), {
      exitCode: 128,
      stderr: "fatal: bad revision 'nonexistent-branch'",
    });
    mockExeca.mockRejectedValueOnce(err);
    await expect(getCommitHistory({ limit: 10, branch: 'nonexistent-branch' })).rejects.toThrow();
  });
});
