/**
 * What a setup re-run reads before deciding whether to scan git and docs again: does this
 * repo already have rows in the graph, and did its docs already land. Both are answered by
 * the database, never by remembering a previous run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';

vi.setConfig({ testTimeout: 30_000 });

describe('local-db repo reads for an additive setup re-run', () => {
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-repo-reads-${Date.now()}-${Math.trunc(performance.now())}.db`);
  });
  afterEach(() => {
    db?.close();
    db = undefined;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
  });

  it('counts the GIT decisions stamped with a repo, and 0 for a repo the graph has never seen', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'a', summary: 'a', sourceUrl: 'https://github.com/o/r/commit/1', platform: 'git', repo: 'github.com/o/r' });
    db.insertDecision({ title: 'b', summary: 'b', sourceUrl: 'https://github.com/o/r/commit/2', platform: 'git', repo: 'github.com/o/r' });
    db.insertDecision({ title: 'c', summary: 'c', sourceUrl: 'https://github.com/x/y/commit/3', platform: 'git', repo: 'github.com/x/y' });
    expect(db.gitDecisionCount('github.com/o/r')).toBe(2);
    expect(db.gitDecisionCount('github.com/nobody/nothing')).toBe(0);
  });

  it('does not count a GitHub PR stamped with the repo as scanned git history', () => {
    // Every hosted code URL stamps its repo (a PR captured by hand is still code), so "any
    // row with this repo" would call a git history scanned when only PRs had landed. A
    // fresh-context review caught the first cut doing exactly that.
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'pr', summary: 'x', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github', repo: 'github.com/o/r' });
    expect(db.gitDecisionCount('github.com/o/r')).toBe(0);
  });

  it('knows whether docs from a repo landed, by the blob URL the docs importer writes', () => {
    // Docs rows carry no repo stamp (a blob URL is not a commit/pull/issue URL), so the
    // question is answered from the URL the importer builds: <host>/<owner>/<repo>/blob/...
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'ADR 1', summary: 'x', sourceUrl: 'https://github.com/o/r/blob/main/docs/adr/0001.md', platform: 'docs' });
    expect(db.hasDocsForRepo('github.com/o/r')).toBe(true);
    expect(db.hasDocsForRepo('github.com/o/r2')).toBe(false); // a prefix of another repo name is not that repo
    expect(db.hasDocsForRepo('github.com/x/y')).toBe(false);
  });

  it('matches the GitLab blob URL shape, which carries a /-/ segment', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'ADR', summary: 'x', sourceUrl: 'https://gitlab.com/g/r/-/blob/main/adr/1.md', platform: 'docs' });
    expect(db.hasDocsForRepo('gitlab.com/g/r')).toBe(true);
    expect(db.hasDocsForRepo('gitlab.com/g/r2')).toBe(false);
  });

  it('cannot attribute docs from a repo with no hosted remote, and says no rather than guessing', () => {
    // No remote: the docs importer writes git://blob/<branch>/<path>, which names no repo,
    // and the repo identity is the absolute checkout path. Re-reading docs there is the
    // honest answer (idempotent, a few files); a false yes would skip them for good.
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'ADR', summary: 'x', sourceUrl: 'git://blob/main/docs/adr/1.md', platform: 'docs' });
    expect(db.hasDocsForRepo('/home/someone/proj')).toBe(false);
  });

  it('treats underscore and percent in a repo name literally, never as wildcards', () => {
    // SQL LIKE: `_` is any one character, so my_repo would otherwise match my-repo's docs
    // and skip a docs read that was never done.
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'ADR', summary: 'x', sourceUrl: 'https://github.com/o/my-repo/blob/main/adr/1.md', platform: 'docs' });
    expect(db.hasDocsForRepo('github.com/o/my_repo')).toBe(false);
    expect(db.hasDocsForRepo('github.com/o/my-repo')).toBe(true);
    expect(db.hasDocsForRepo('github.com/o/my%')).toBe(false);
  });

  it('does not count a git row as docs, and is case-insensitive on the host and path', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'a', summary: 'a', sourceUrl: 'https://github.com/O/R/commit/1', platform: 'git', repo: 'github.com/o/r' });
    expect(db.hasDocsForRepo('github.com/o/r')).toBe(false);
    db.insertDecision({ title: 'ADR', summary: 'x', sourceUrl: 'https://GitHub.com/O/R/blob/main/adr/1.md', platform: 'docs' });
    expect(db.hasDocsForRepo('github.com/o/r')).toBe(true);
  });
});
