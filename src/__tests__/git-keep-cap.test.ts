import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCommitHistoryDetailed } from '../lib/git.js';
import { gitCaptureReport, gitCaptureSkips } from '../lib/fetchers/git.js';
import { GIT_DEFAULT_LIMIT, GIT_KEEP_CAP } from '../lib/import-defaults.js';

/** `limit` bounds what git SCANS, `keep` bounds what is returned. Real git, synthetic history. */
describe('getCommitHistoryDetailed: scan bound and keep cap', () => {
  let repo: string;
  const git = (args: string[]) =>
    execa('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
  let n = 0;
  const commit = async (message: string) => {
    writeFileSync(join(repo, 'f.txt'), String(n++));
    await git(['add', '.']);
    await git(['commit', '-qm', message]);
  };
  const reasoned = (what: string) => `feat: replace ${what} with something faster\n\nThe old ${what} allocated on every request, which we measured under load.`;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-1749-'));
    await git(['init', '-q', '-b', 'main']);
    // oldest first: one old reasoned decision, then 9 mechanical commits, then 4 recent reasoned ones
    await commit(reasoned('ancient router'));
    for (let i = 0; i < 9; i++) await commit(`chore: bump dependency number ${i} to latest`);
    for (const w of ['alpha parser', 'beta logger', 'gamma cache', 'delta queue']) await commit(reasoned(w));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('a scan bound shorter than the history never sees the old commit', async () => {
    const r = await getCommitHistoryDetailed({ limit: 6, cwd: repo });
    expect(r.scanned).toBe(6);
    expect(r.commits.map(c => c.subject)).not.toContain('feat: replace ancient router with something faster');
  });

  it('a scan bound that reaches the start imports the old commit that states a reason', async () => {
    const r = await getCommitHistoryDetailed({ limit: 100, cwd: repo });
    expect(r.scanned).toBe(14);
    expect(r.commits.map(c => c.subject)).toContain('feat: replace ancient router with something faster');
    expect(r.droppedByCap).toBe(0);
  });

  it('keep returns the NEWEST qualifying commits and counts what it left out', async () => {
    const r = await getCommitHistoryDetailed({ limit: 100, keep: 2, cwd: repo });
    expect(r.commits.map(c => c.subject)).toEqual([
      'feat: replace delta queue with something faster',
      'feat: replace gamma cache with something faster',
    ]);
    expect(r.droppedByCap).toBe(3);
    expect(r.scanned).toBe(14);
  });

  it('a different keep gives a different cut (two examples of the rule)', async () => {
    const r = await getCommitHistoryDetailed({ limit: 100, keep: 4, cwd: repo });
    expect(r.commits).toHaveLength(4);
    expect(r.droppedByCap).toBe(1);
    expect(r.commits.map(c => c.subject)).not.toContain('feat: replace ancient router with something faster');
  });

  it('keep larger than what qualifies drops nothing', async () => {
    const r = await getCommitHistoryDetailed({ limit: 100, keep: 50, cwd: repo });
    expect(r.commits).toHaveLength(5);
    expect(r.droppedByCap).toBe(0);
  });
});

describe('capture report with a keep cap', () => {
  it('names the capped commits and keeps the mechanical count honest', () => {
    const skips = gitCaptureSkips({ scanned: 14, kept: 2, rejectedByRationale: 0, droppedByCap: 3 });
    expect(skips.find(s => /not imported/.test(s.detail))?.count).toBe(3);
    expect(skips.find(s => /mechanical/.test(s.detail))?.count).toBe(9);
  });
  it('says nothing about a cap that dropped nothing', () => {
    expect(gitCaptureSkips({ scanned: 10, kept: 10, rejectedByRationale: 0, droppedByCap: 0 })).toEqual([]);
  });
  it('a scan that stopped short of its bound read the whole history', () => {
    expect(gitCaptureReport({ scanned: 4906, kept: 1415, rejectedByRationale: 2000, limit: GIT_DEFAULT_LIMIT, droppedByCap: 0 }).complete).toBe(true);
  });
});

describe('the default bounds', () => {
  it('reach back past 500 commits and cap what a first run embeds', () => {
    expect(GIT_DEFAULT_LIMIT).toBeGreaterThan(5_000);
    expect(GIT_KEEP_CAP).toBeGreaterThan(0);
    expect(GIT_KEEP_CAP).toBeLessThanOrEqual(GIT_DEFAULT_LIMIT);
  });
});
