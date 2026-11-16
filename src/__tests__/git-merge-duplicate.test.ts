/**
 * A merge commit that only carries another commit's change is not imported as its own decision.
 * Real git, real merge commits (a mocked `git log` would not prove the parser sees the shape git emits).
 *
 * Test List:
 * 1. a merge whose PR title repeats a branch commit's subject, and adds no text, is not returned (twin stays)
 * 2. same rule, second example: two such merges in one history are both dropped
 * 3. pair: a merge whose own text states a decision of its own is kept
 * 4. pair: a merge whose title matches no commit in the scan is kept
 * 5. the report counts the dropped merges apart, so "housekeeping" is not overstated
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCommitHistoryDetailed } from '../lib/git.js';
import { gitCaptureReport } from '../lib/fetchers/git.js';

describe('getCommitHistoryDetailed: merge commits that only carry another commit', () => {
  let repo: string;
  const git = (args: string[]) =>
    execa('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
  let n = 0;
  const commit = async (message: string) => {
    writeFileSync(join(repo, `f${n}.txt`), String(n++));
    await git(['add', '.']);
    await git(['commit', '-qm', message]);
  };
  const reasoned = (title: string) => `${title}\n\nThe old value was measured under load and held back the whole lab, so it changed.`;
  /** A GitHub-style merge: boilerplate subject, the PR title as the body, `ownBody` after it. */
  const branchAndMerge = async (branch: string, branchCommitMessage: string, prTitle: string, ownBody = '') => {
    await git(['checkout', '-q', '-b', branch]);
    await commit(branchCommitMessage);
    await git(['checkout', '-q', 'main']);
    await commit(`docs: note on ${branch} timing that is unrelated`);
    await git(['merge', '--no-ff', '-q', branch, '-m', `Merge pull request #${n} from x/${branch}`, '-m', ownBody ? `${prTitle}\n\n${ownBody}` : prTitle]);
  };
  const history = () => getCommitHistoryDetailed({ limit: 100, cwd: repo });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-merge-dup-'));
    await git(['init', '-q', '-b', 'main']);
    await commit('chore: initial layout of the repository');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('drops a merge that repeats a branch commit title and adds nothing', async () => {
    await branchAndMerge('tick', reasoned('v4.07: the lab runs at 10 Hz'), 'v4.07: the lab runs at 10 Hz');
    const r = await history();
    expect(r.commits.filter(c => c.subject === 'v4.07: the lab runs at 10 Hz')).toHaveLength(1);
    expect(r.commits.filter(c => /^Merge pull request/m.test(c.body))).toHaveLength(0);
  });

  it('drops every such merge, not only the first', async () => {
    await branchAndMerge('tick', reasoned('Run the lab at 10 Hz'), 'Run the lab at 10 Hz');
    await branchAndMerge('swim', reasoned('Scale swim drag by frametime'), 'Scale swim drag by frametime');
    const r = await history();
    expect(r.commits.map(c => c.subject).sort()).toEqual(['Run the lab at 10 Hz', 'Scale swim drag by frametime']);
    expect(r.mergeDuplicates).toBe(2);
  });

  it('keeps a merge whose own text states a decision', async () => {
    await branchAndMerge('tick', reasoned('Run the lab at 10 Hz'), 'Run the lab at 10 Hz',
      'We also froze the tick at 0.1 because the dedicated server clamps frametime there, which the audit measured.');
    const r = await history();
    expect(r.commits.filter(c => c.subject === 'Run the lab at 10 Hz')).toHaveLength(2);
    expect(r.mergeDuplicates).toBe(0);
  });

  it('keeps a merge whose title matches no commit in the scan', async () => {
    await branchAndMerge('tick', reasoned('Fix the lab tick to a constant'), 'Adopt a fixed tick for every rig');
    const subjects = (await history()).commits.map(c => c.subject);
    expect(subjects).toContain('Adopt a fixed tick for every rig');
    expect(subjects).toContain('Fix the lab tick to a constant');
  });

  it('reports dropped merges as their own skip line', async () => {
    await branchAndMerge('tick', reasoned('Run the lab at 10 Hz'), 'Run the lab at 10 Hz');
    const c = await history();
    const report = gitCaptureReport({ scanned: c.scanned, kept: c.commits.length, rejectedByRationale: c.rejectedByRationale, limit: 100, droppedByCap: c.droppedByCap, mergeDuplicates: c.mergeDuplicates });
    expect(report.skips.find(s => /merge/i.test(s.detail) && /repeat/i.test(s.detail))?.count).toBe(1);
    // only the initial chore commit is housekeeping; the merge is not folded into that count
    expect(report.skips.find(s => /housekeeping/.test(s.detail))?.count).toBe(1);
  });
});
