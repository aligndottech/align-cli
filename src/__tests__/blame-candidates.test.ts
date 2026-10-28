/**
 * Test list: decisions that wrote the code a planned change touches, as candidates for the pre-edit check.
 *  1. A unified diff whose old side covers a blamed line yields that line's decision (blame-lines), not another commit's.
 *  2. Prose naming a tracked file yields its newest writers (blame-file), capped at 3.
 *  3. Prose naming no file, a path outside the repo, an untracked file: nothing.
 *  4. Prose and lockfile paths are skipped with no git call.
 *  5. A routine-typed writer (docs, refactor) is not a candidate. One decision named by two files appears once.
 *  6. A blame that never answers inside the budget returns [] (the old candidate set).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { blameCandidates, parseDiffOldRanges, pathsNamedIn } from '../lib/blame-candidates.js';
import { createLocalDb } from '../lib/local-db.js';

let dir: string;
let outside: string;
const db = createLocalDb(':memory:');
let clock = 1_700_000_000;
const shaOf = new Map<string, string>();
const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: `${clock++} +0000`, GIT_AUTHOR_DATE: `${clock} +0000` } }).trim();
/** Commit `content` to `file`, and record the commit as a decision titled `title`. */
const decide = (file: string, content: string, title: string, asDecision = true): string => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
  git('add', file);
  git('commit', '-q', '-m', title);
  const sha = git('rev-parse', 'HEAD');
  shaOf.set(title, sha);
  if (asDecision) db.insertDecision({ title, summary: 's', sourceUrl: `https://github.com/acme/w/commit/${sha}`, platform: 'git' });
  return sha;
};
const titles = (rows: Array<{ row: { title: string } }>): string[] => rows.map((c) => c.row.title);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'align-cand-'));
  git('init', '-q', '-b', 'main');
  decide('lib/status.js', 'one\ntwo\nthree\n', 'fix: write status');
  decide('lib/status.js', 'one\nTWO\nthree\n', 'feat: widen the status range');
  decide('README.md', 'hello\n', 'Add the readme');
  decide('package-lock.json', '{}\n', 'Add the lockfile');
  decide('many.js', 'a\n', 'fix: many one');
  decide('many.js', 'a\nb\n', 'fix: many two');
  decide('many.js', 'a\nb\nc\n', 'fix: many three');
  decide('many.js', 'a\nb\nc\nd\n', 'fix: many four');
  decide('many.js', 'a\nb\nc\nd\ne\n', 'docs: many five (routine, not a writer)');
  decide('refac.js', 'x\n', 'refactor: reshuffle');
  writeFileSync(path.join(dir, 'untracked.js'), 'x\n');
  outside = path.join(mkdtempSync(path.join(tmpdir(), 'align-cand-out-')), 'elsewhere.js');
  writeFileSync(outside, 'x\n');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.dirname(outside), { recursive: true, force: true });
});

const DIFF = '--- a/lib/status.js\n+++ b/lib/status.js\n@@ -2,1 +2,1 @@\n-TWO\n+TWO2\n';
const never = (): Promise<{ stdout: string }> => new Promise(() => {});

describe('blameCandidates', () => {
  it('a unified diff yields the decision that wrote the old lines, and not another commit\'s', async () => {
    const got = await blameCandidates(DIFF, dir, db);
    expect(titles(got)).toEqual(['feat: widen the status range']);
    expect(got[0]?.via).toBe('blame-lines');
  });

  it('prose naming a tracked file yields its newest writers, capped at 3, marked blame-file', async () => {
    const got = await blameCandidates('In many.js, change the loop to stop at the second item.', dir, db);
    expect(titles(got)).toEqual(['fix: many four', 'fix: many three', 'fix: many two']);
    expect(got.every((c) => c.via === 'blame-file')).toBe(true);
  });

  it('prose with no file name, a path outside the repo, an absolute outside path and an untracked file give nothing', async () => {
    const relOutside = path.relative(dir, outside);
    for (const text of ['make the status range wider', `edit ${outside}`, `edit ${relOutside}`, 'edit untracked.js', 'edit nope/missing.js']) {
      expect(await blameCandidates(text, dir, db), text).toEqual([]);
    }
  });

  it('a file outside the repo is never blamed, not even attempted', async () => {
    let calls = 0;
    const run = (): Promise<{ stdout: string }> => { calls++; return Promise.resolve({ stdout: '' }); };
    expect(await blameCandidates(`edit ${outside} and ${path.relative(dir, outside)}`, dir, db, { runGit: run })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('prose and lockfile paths are skipped without any git call', async () => {
    let calls = 0;
    const run = (): Promise<{ stdout: string }> => { calls++; return Promise.resolve({ stdout: '' }); };
    expect(await blameCandidates('update README.md and package-lock.json', dir, db, { runGit: run })).toEqual([]);
    expect(await blameCandidates('--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-hello\n+hi\n', dir, db, { runGit: run })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('a refactor-typed writer is not a candidate, and the same decision named twice appears once', async () => {
    expect(await blameCandidates('look at refac.js', dir, db)).toEqual([]);
    const twice = await blameCandidates('lib/status.js and ./lib/status.js again', dir, db);
    expect(titles(twice).filter((t) => t === 'feat: widen the status range')).toHaveLength(1);
  });

  it('gives up to [] when blame never answers inside the budget', async () => {
    const t0 = Date.now();
    expect(await blameCandidates(DIFF, dir, db, { timeoutMs: 20, runGit: never })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('positive control: a fake blame that answers inside the budget yields its writer', async () => {
    const sha = shaOf.get('feat: widen the status range')!;
    const answers = (): Promise<{ stdout: string }> => Promise.resolve({ stdout: `${sha} 1 1 1\nsummary x\ncommitter-time 5\n\tone\n` });
    expect(titles(await blameCandidates(DIFF, dir, db, { runGit: answers }))).toEqual(['feat: widen the status range']);
  });
});

describe('parsing', () => {
  it('reads old-side hunk ranges per file and ignores new files and pure insertions', () => {
    const text = '--- a/x.js\n+++ b/x.js\n@@ -3,2 +3,4 @@\n@@ -10 +12 @@\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,3 @@\n--- a/y.js\n+++ b/y.js\n@@ -5,0 +6,1 @@\n';
    expect([...parseDiffOldRanges(text)]).toEqual([['x.js', [[3, 4], [10, 10]]]]);
  });

  it('finds file-looking tokens in prose and ignores version numbers and bare words', () => {
    expect(pathsNamedIn('In lib/error-status.js (and a.ts), bump 1.2.3, e.g. node 0.0.0.0 not foo')).toEqual(['lib/error-status.js', 'a.ts', 'e.g']);
  });
});
