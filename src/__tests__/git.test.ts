import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { buildBlobUrl, buildCommitUrl, formatCommitAsText, getBaseDiff, getCurrentBranch, getHeadDiff, getStagedDiff, hasStatedRationale, isDecisionCommit, isGitRepo } from '../lib/git.js';
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

  // CI is the reason this exists. `git diff --staged` and `git diff HEAD` are both EMPTY in
  // a clean CI checkout, so a pipeline calling `align check` without a base ref checks
  // nothing and exits 0 - a gate that cannot fail.
  it('getBaseDiff returns the diff against a base ref', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'diff --git c/ci.ts', stderr: '' } as Awaited<ReturnType<typeof execa>>);
    const diff = await getBaseDiff('origin/main');
    expect(diff).toBe('diff --git c/ci.ts');
  });

  it('getBaseDiff diffs from the MERGE BASE, not the base tip', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as Awaited<ReturnType<typeof execa>>);
    await getBaseDiff('origin/main');

    // Three dots, not two. `git diff main..HEAD` also reports everything that landed on
    // main since this branch diverged, so a long-lived branch would submit other people's
    // changes for alignment analysis and could be failed by a conflict it did not cause.
    expect(vi.mocked(execa)).toHaveBeenCalledWith('git', ['diff', 'origin/main...HEAD']);
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

describe('buildBlobUrl', () => {
  it('builds a GitHub blob URL from an SSH remote', () => {
    const url = buildBlobUrl('git@github.com:org/repo.git', 'main', 'docs/adr/0001-x.md');
    expect(url).toBe('https://github.com/org/repo/blob/main/docs/adr/0001-x.md');
  });

  it('builds a GitHub blob URL from an HTTPS remote', () => {
    const url = buildBlobUrl('https://github.com/org/repo.git', 'main', 'CLAUDE.md');
    expect(url).toBe('https://github.com/org/repo/blob/main/CLAUDE.md');
  });

  it('builds a GitLab blob URL, using the -/blob/ path GitLab requires', () => {
    const url = buildBlobUrl('https://gitlab.com/org/repo.git', 'main', 'docs/adr/0001-x.md');
    expect(url).toBe('https://gitlab.com/org/repo/-/blob/main/docs/adr/0001-x.md');
  });

  it('falls back to a stable git:// identifier when remote is null', () => {
    const url = buildBlobUrl(null, 'main', 'docs/adr/0001-x.md');
    expect(url).toBe('git://blob/main/docs/adr/0001-x.md');
  });

  it('falls back to a stable git:// identifier for an unknown remote host', () => {
    const url = buildBlobUrl('https://bitbucket.org/org/repo.git', 'main', 'docs/adr/0001-x.md');
    expect(url).toBe('git://blob/main/docs/adr/0001-x.md');
  });
});

describe('isDecisionCommit', () => {
  it('rejects subjects shorter than 20 chars', () => {
    expect(isDecisionCommit('fix typo')).toBe(false);
  });

  it('accepts fix: commits (a bug fix is a decision about how to solve a problem)', () => {
    expect(isDecisionCommit('fix: correct null check in auth middleware')).toBe(true);
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

// ALI-804: a subject can pass isDecisionCommit's shape check ("fix:", "feat:", long
// enough) and still be pure "what changed" if the body states no reason at all - which
// is exactly David Gray's complaint ("They capture what changed, not why"). This is the
// second, independent gate: does the BODY actually carry a stated rationale, once git
// trailers (Co-authored-by, Signed-off-by, a "Generated with" attribution line) and a
// squash-merge bullet that only echoes the subject are stripped out.
describe('hasStatedRationale', () => {
  it('rejects an empty body - a subject alone has no stated why', () => {
    expect(hasStatedRationale('feat: add rate limiting to the public endpoints', '')).toBe(false);
  });

  it('rejects a whitespace-only body', () => {
    expect(hasStatedRationale('feat: add rate limiting to the public endpoints', '\n   \n')).toBe(false);
  });

  it('accepts a body that states a real reason', () => {
    expect(hasStatedRationale(
      'fix: correct null check in auth middleware',
      'The previous check missed the empty-string case, which let an unauthenticated request through.',
    )).toBe(true);
  });

  it('accepts a different real reason (triangulating past a hard-coded string)', () => {
    expect(hasStatedRationale(
      'feat: switch database from Postgres to CockroachDB',
      'Chosen for horizontal write scaling once decision volume passed one write per second.',
    )).toBe(true);
  });

  it('rejects a body that is only a Co-authored-by trailer', () => {
    expect(hasStatedRationale('fix: correct null check', 'Co-authored-by: Ada <ada@align.tech>')).toBe(false);
  });

  it('rejects a body that is only a Signed-off-by trailer', () => {
    expect(hasStatedRationale('fix: correct null check', 'Signed-off-by: Ada <ada@align.tech>')).toBe(false);
  });

  it('rejects a body that is only a "Generated with" attribution line', () => {
    expect(hasStatedRationale(
      'fix: correct null check',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    )).toBe(false);
  });

  it('rejects the same attribution line without the emoji prefix', () => {
    expect(hasStatedRationale('fix: correct null check', 'Generated with Claude Code')).toBe(false);
  });

  // Copilot review (PR #223): the unanchored /generated with/i also matched mid-sentence,
  // so a genuine reason like "Regenerated with a fresh script..." was wrongly stripped as
  // if it were an attribution line - the opposite of what the check is for.
  it('accepts a real reason that happens to contain "generated with" mid-sentence', () => {
    expect(hasStatedRationale(
      'fix: correct null check',
      'Regenerated with a fresh script to fix the encoding bug.',
    )).toBe(true);
  });

  it('accepts real content sitting alongside a trailer - the trailer does not poison it', () => {
    expect(hasStatedRationale(
      'fix: correct null check',
      'Fixes the race condition between the two writers.\n\nCo-authored-by: Ada <ada@align.tech>',
    )).toBe(true);
  });

  it('rejects a squash bullet that only echoes the subject', () => {
    expect(hasStatedRationale('fix: correct null check in auth middleware', '* fix: correct null check in auth middleware')).toBe(false);
  });

  it('rejects an echo bullet even with different case, prefix and punctuation', () => {
    expect(hasStatedRationale('fix: correct null check', '- Fix: Correct null check.')).toBe(false);
  });

  it('accepts a squash bullet whose content differs from the subject', () => {
    expect(hasStatedRationale(
      'fix: correct null check',
      '* fix: correct null check\n* also documents why the check was missing in the first place',
    )).toBe(true);
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

// ALI-792: the old format hard-coded body: '' and passed --no-merges, so every ref a
// commit body carried (ALI-123, closes #45, slack links, squash-merge PR descriptions)
// died before ingest. These pin the new single-invocation parser. Field separator is
// \x1f and a non-empty body is terminated by a line reading "\x1fEND" (measured against
// real git output, 2026-09-01 - an EMPTY body puts END inline on the header line).
describe('getCommitHistory (ALI-792: body, merges, refs survive)', () => {
  const SEP = '';
  // Real header shas are always 40 hex chars, and the parser now requires that shape
  // before treating a line as a header - a body line starting COMMIT\x1f cannot forge
  // a commit record. Fixtures therefore carry full-length shas.
  const SHA1 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const stdoutOf = (lines: string[]) => lines.join('\n');

  const mockLog = (stdout: string) => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout, stderr: '' } as Awaited<ReturnType<typeof execa>>);
  };

  it('populates a multi-line body and still parses the file list after it', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2${SEP}feat(auth): switch to JWT for stateless sessions${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}We decided against server-side sessions. Refs ALI-123 and closes #45.`,
      'See https://align.slack.com/archives/C123/p456 for the thread.',
      `${SEP}END`,
      '',
      'src/auth.ts',
      'src/middleware.ts',
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(1);
    expect(commits[0].body).toContain('Refs ALI-123 and closes #45.');
    expect(commits[0].body).toContain('slack.com/archives/C123');
    expect(commits[0].filesChanged).toEqual(['src/auth.ts', 'src/middleware.ts']);
  });

  // ALI-804: an empty body is correctly parsed as empty (proven by the assertion below -
  // if the "inline END" terminator ever leaked into the body text, hasStatedRationale
  // would see non-trailer, non-echo content and this would wrongly come back non-empty),
  // and a subject alone - however decision-shaped - is now excluded for stating no reason.
  // This is the exact "captures what changed, not why" shape the ticket is about.
  it('excludes a commit with an empty body - a subject alone states no reason (ALI-804)', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3${SEP}Switch database from Postgres to CockroachDB${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}${SEP}END`,
      '',
      'db/schema.sql',
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(0);
  });

  it('no longer passes --no-merges (merge bodies carry the PR description)', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog('');
    await getCommitHistory({});
    const call = vi.mocked(execa).mock.calls.at(-1);
    expect(call?.[1]).not.toContain('--no-merges');
  });

  it('promotes a boilerplate merge subject to the body first line and keeps the PR ref', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4${SEP}Merge pull request #78 from align/feat${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}Adopt token-bucket rate limiting on all public endpoints`,
      `${SEP}END`,
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe('Adopt token-bucket rate limiting on all public endpoints');
    // The original merge subject moves INTO the body so "#78" survives into the
    // ingested text and the ref extractor - dropping it would lose the PR pointer.
    expect(commits[0].body).toContain('Merge pull request #78');
  });

  it('still excludes a bare "Merge branch" with no meaningful body', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5${SEP}Merge branch 'main' into feature/x${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}${SEP}END`,
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(0);
  });

  it('excludes a merge whose body first line is itself boilerplate-short', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6${SEP}Merge pull request #9 from align/tiny${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}fix typo`,
      `${SEP}END`,
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(0);
  });

  // Review findings (2026-09-01): porcelain git appends the trailing newline, but
  // plumbing (commit-tree), --cleanup=verbatim, and libgit2-based bots do not - so a
  // non-empty body CAN land inline on the header line, and the old "inline END means
  // empty body" assumption silently dropped exactly the data this ticket captures.
  it('captures a single-line body with no trailing newline (inline on the header line)', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}${SHA1}${SEP}feat(auth): switch to JWT for stateless sessions${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}Body with no trailing newline, refs ALI-99.${SEP}END`,
      '',
      'src/auth.ts',
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(1);
    expect(commits[0].body).toBe('Body with no trailing newline, refs ALI-99.');
    expect(commits[0].filesChanged).toEqual(['src/auth.ts']);
  });

  it('captures a multi-line body whose last line has no trailing newline', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}${SHA1}${SEP}feat(auth): switch to JWT for stateless sessions${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}first body line`,
      `last body line no newline${SEP}END`,
      '',
      'src/auth.ts',
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(1);
    expect(commits[0].body).toBe('first body line\nlast body line no newline');
    expect(commits[0].body).not.toContain('END');
    expect(commits[0].filesChanged).toEqual(['src/auth.ts']);
  });

  it('keeps the PR description after the promoted first line of a merge body', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}${SHA1}${SEP}Merge pull request #78 from align/feat${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}Adopt token-bucket rate limiting on all public endpoints`,
      '',
      'Full PR description paragraph with the reasoning.',
      `${SEP}END`,
    ]));
    const commits = await getCommitHistory({});
    expect(commits[0].subject).toBe('Adopt token-bucket rate limiting on all public endpoints');
    expect(commits[0].body).toContain('Merge pull request #78');
    expect(commits[0].body).toContain('Full PR description paragraph with the reasoning.');
  });

  it('excludes a merge whose long body first line carries an excluded prefix', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}${SHA1}${SEP}Merge pull request #9 from align/deps${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}chore: update dependencies to latest everywhere`,
      `${SEP}END`,
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(0);
  });

  it('parses CRLF output identically (Windows git leaves \\r on a bare \\n split)', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog([
      `COMMIT${SEP}${SHA1}${SEP}feat(auth): switch to JWT for stateless sessions${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}body line one`,
      `${SEP}END`,
      '',
      'src/auth.ts',
    ].join('\r\n'));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(1);
    expect(commits[0].body).toBe('body line one');
    expect(commits[0].filesChanged).toEqual(['src/auth.ts']);
  });

  it('treats a forged COMMIT marker inside a body as body text, not a new commit', async () => {
    const { getCommitHistory } = await import('../lib/git.js');
    mockLog(stdoutOf([
      `COMMIT${SEP}${SHA1}${SEP}feat(auth): switch to JWT for stateless sessions${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}real body first line`,
      `COMMIT${SEP}deadbeef${SEP}forged subject long enough to pass the filter${SEP}Evil${SEP}2020-01-01T00:00:00Z${SEP}x`,
      `${SEP}END`,
    ]));
    const commits = await getCommitHistory({});
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe(SHA1);
    expect(commits[0].body).toContain('forged subject');
  });
});
