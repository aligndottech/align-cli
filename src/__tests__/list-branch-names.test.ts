/**
 * `listBranchNames` against a REAL git repository.
 *
 * Copilot, #310: every other test in this area feeds `pickBaseRef` a hand-built array, so none
 * of them can catch a wrong `git branch --format` string or a broken mapping - the parser sits
 * entirely outside their reach. That is the gap that matters here, because the whole remote/
 * local distinction rests on `%(refname)` returning full refs.
 *
 * So this builds a throwaway repo with the three shapes that are easy to get wrong:
 * a local branch containing a slash, a remote ref, and a symbolic origin/HEAD.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listBranchNames, pickBaseRef } from '../lib/git.js';

describe('listBranchNames (ALI-1105)', () => {
  let dir: string;
  let names: string[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'align-branches-'));
    const git = (...args: string[]) => execa('git', args, { cwd: dir });
    await git('init', '-q');
    await git('config', 'user.email', 't@t.t');
    await git('config', 'user.name', 't');
    await git('commit', '-q', '--allow-empty', '-m', 'base');
    await git('branch', '-M', 'main');
    // A LOCAL branch with a slash - the shape a prefix heuristic cannot tell from a remote.
    await git('branch', 'feature/login');
    // A remote, faked by writing the refs directly so no network is involved.
    const sha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('update-ref', 'refs/remotes/origin/main', sha);
    await git('update-ref', 'refs/remotes/origin/trunk', sha);
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    names = await listBranchNames({ cwd: dir });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('marks remote refs and leaves local ones bare', () => {
    expect(names).toContain('remote:origin/main');
    expect(names).toContain('main');
  });

  /**
   * The load-bearing case. `feature/login` is local and contains a slash, so any rule that
   * infers "remote" from the shape of the string gets it wrong.
   */
  it('does not mark a slashed LOCAL branch as remote', () => {
    expect(names).toContain('feature/login');
    expect(names).not.toContain('remote:feature/login');
  });

  it('carries the symbolic origin/HEAD, marked as remote', () => {
    expect(names.some((n) => n.startsWith('remote:origin/HEAD ->'))).toBe(true);
  });

  /** End to end: the repo declares trunk as its default, so that is the base. */
  it('resolves the declared default through pickBaseRef', () => {
    expect(pickBaseRef(names)).toBe('origin/trunk');
  });

  /** Positive control: a directory that is not a repo yields nothing, loudly-empty. */
  it('returns an empty list outside a repository', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'align-norepo-'));
    expect(await listBranchNames({ cwd: empty })).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
