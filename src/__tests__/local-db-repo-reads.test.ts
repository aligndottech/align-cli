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

  it('counts the decisions stamped with a repo, and 0 for a repo the graph has never seen', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'a', summary: 'a', sourceUrl: 'https://github.com/o/r/commit/1', platform: 'git', repo: 'github.com/o/r' });
    db.insertDecision({ title: 'b', summary: 'b', sourceUrl: 'https://github.com/o/r/commit/2', platform: 'git', repo: 'github.com/o/r' });
    db.insertDecision({ title: 'c', summary: 'c', sourceUrl: 'https://github.com/x/y/commit/3', platform: 'git', repo: 'github.com/x/y' });
    expect(db.repoDecisionCount('github.com/o/r')).toBe(2);
    expect(db.repoDecisionCount('github.com/nobody/nothing')).toBe(0);
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

  it('does not count a git row as docs, and is case-insensitive on the host and path', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'a', summary: 'a', sourceUrl: 'https://github.com/O/R/commit/1', platform: 'git', repo: 'github.com/o/r' });
    expect(db.hasDocsForRepo('github.com/o/r')).toBe(false);
    db.insertDecision({ title: 'ADR', summary: 'x', sourceUrl: 'https://GitHub.com/O/R/blob/main/adr/1.md', platform: 'docs' });
    expect(db.hasDocsForRepo('github.com/o/r')).toBe(true);
  });
});
