import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCommitHistory } from '../lib/git.js';

/**
 * ALI-792: the parser's contract (field separator, body terminator placement, file-list
 * position, merge output shape) was measured against real git before it was written.
 * This test IS that measurement, automated - the unit fixtures in git.test.ts mirror
 * what this pins, and if a git version ever renders the format differently, this is
 * the test that says so while the mocked ones stay green.
 */
describe('getCommitHistory against real git output', () => {
  let repo: string;

  const git = (args: string[]) =>
    execa('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Real Git', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Real Git', GIT_COMMITTER_EMAIL: 't@t' } });

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-792-'));
    await git(['init', '-q', '-b', 'main']);

    writeFileSync(join(repo, 'a.txt'), 'a');
    await git(['add', '.']);
    await git(['commit', '-qm',
      'feat(auth): switch to JWT for stateless sessions\n\nWe decided against server-side sessions. Refs ALI-123 and closes #45.\nSee https://align.slack.com/archives/C123/p456 for the thread.']);

    writeFileSync(join(repo, 'b.txt'), 'b');
    await git(['add', '.']);
    await git(['commit', '-qm', 'short subject']);

    await git(['checkout', '-qb', 'feat']);
    writeFileSync(join(repo, 'c.txt'), 'c');
    await git(['add', '.']);
    await git(['commit', '-qm', 'feat: add rate limiting to the public API endpoints']);
    await git(['checkout', '-q', 'main']);
    await git(['merge', '-q', '--no-ff', 'feat', '-m',
      'Merge pull request #78 from align/feat\n\nAdopt token-bucket rate limiting on all public endpoints']);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('parses bodies, files and the promoted merge from a real repository', async () => {
    // cwd option rather than process.chdir: vitest runs files concurrently in worker
    // threads, and a chdir would leak into any test resolving relative paths
    // (Copilot review, PR #213).
    const commits = await getCommitHistory({ cwd: repo });

    const subjects = commits.map(c => c.subject);
    // "short subject" is excluded by the decision filter (subject shape); the bodyless
    // "feat: add rate limiting..." is excluded by ALI-804's rationale gate (a real subject
    // with nothing behind it is still "what changed", not "why") - only the JWT commit
    // and the promoted merge state an actual reason. Proven here against REAL git output,
    // not a mock, so a parser regression in either gate would show up here too.
    expect(subjects).toHaveLength(2);
    expect(subjects).not.toContain('short subject');
    expect(subjects).not.toContain('feat: add rate limiting to the public API endpoints');

    const jwt = commits.find(c => c.subject.startsWith('feat(auth)'));
    expect(jwt?.body).toContain('Refs ALI-123 and closes #45.');
    expect(jwt?.body).toContain('https://align.slack.com/archives/C123/p456');
    expect(jwt?.filesChanged).toEqual(['a.txt']);

    const merge = commits.find(c => c.subject === 'Adopt token-bucket rate limiting on all public endpoints');
    expect(merge, 'merge promoted to its body first line').toBeDefined();
    expect(merge?.body).toContain('Merge pull request #78');
    // Real git emits NO file list for a merge under --name-only without -m.
    expect(merge?.filesChanged).toEqual([]);
  });
});
