/**
 * Test list (ALI-1749): the decisions that wrote the lines an edit is about to change.
 *
 *  1. Edit: the commit that wrote old_string's lines is returned (positive control), and a
 *     line from a DIFFERENT commit in the same file is not (negative control).
 *  2. Edit whose old_string occurs on lines from two commits returns both.
 *  3. MultiEdit: every edit's lines are blamed.
 *  4. Write over an existing file: only the lines the new content changes are blamed.
 *  5. Squash subject "(#N)" -> the PR url from the origin remote; "Merge pull request #N" too.
 *  6. Fail open to null: not a repo, untracked file, missing file, old_string not in file,
 *     no file_path, uncommitted lines only, blame timeout. Never throws.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findLineWriters, isWriterTitle } from '../lib/blame-attribution.js';

let dir: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const commit = (file: string, content: string, subject: string): string => {
  writeFileSync(path.join(dir, file), content);
  git('add', file);
  git('commit', '-q', '-m', subject);
  return git('rev-parse', 'HEAD');
};

let sha1: string;
let sha2: string;
let sha3: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'align-blame-'));
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git');
  sha1 = commit('a.js', 'line one\nline two\nline three\nline four\n', 'feat: initial (#11)');
  sha2 = commit('a.js', 'line one\nline TWO changed\nline three\nline four\n', 'fix: change two');
  sha3 = commit('a.js', 'line one\nline TWO changed\nline three\nline FOUR\n', 'Merge pull request #33 from acme/branch');
  writeFileSync(path.join(dir, 'untracked.js'), 'x\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('findLineWriters', () => {
  it('names the commit that wrote the replaced line, and not a commit that wrote other lines', async () => {
    const got = await findLineWriters({ file_path: 'a.js', old_string: 'line TWO changed', new_string: 'x' }, dir);
    expect(got?.commitShas).toEqual([sha2]);
  });

  it('returns both commits when old_string spans lines from two commits', async () => {
    const got = await findLineWriters({ file_path: path.join(dir, 'a.js'), old_string: 'line three\nline FOUR', new_string: 'x' }, dir);
    expect([...(got?.commitShas ?? [])].sort()).toEqual([sha1, sha3].sort());
  });

  it('blames every edit of a MultiEdit', async () => {
    const got = await findLineWriters({ file_path: 'a.js', edits: [{ old_string: 'line one', new_string: 'x' }, { old_string: 'line FOUR', new_string: 'y' }] }, dir);
    expect([...(got?.commitShas ?? [])].sort()).toEqual([sha1, sha3].sort());
  });

  it('for a Write, blames only the lines the new content changes', async () => {
    const got = await findLineWriters({ file_path: 'a.js', content: 'line one\nline TWO changed\nline three\nrewritten\n' }, dir);
    expect(got?.commitShas).toEqual([sha3]);
  });

  it('maps a "(#N)" subject and a "Merge pull request #N" subject to PR urls from origin, lower-cased', async () => {
    const got = await findLineWriters({ file_path: 'a.js', old_string: 'line one\nline TWO changed\nline three\nline FOUR', new_string: 'x' }, dir);
    expect([...(got?.prUrls ?? [])].sort()).toEqual(['https://github.com/acme/widgets/pull/11', 'https://github.com/acme/widgets/pull/33']);
  });

  it('still returns the SHAs, with no PR urls, when the repo has no origin', async () => {
    const solo = mkdtempSync(path.join(tmpdir(), 'align-blame-solo-'));
    try {
      const g = (...a: string[]): string => execFileSync('git', a, { cwd: solo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
      g('init', '-q', '-b', 'main');
      writeFileSync(path.join(solo, 'b.js'), 'only\n');
      g('add', 'b.js');
      g('commit', '-q', '-m', 'feat: only (#5)');
      const got = await findLineWriters({ file_path: 'b.js', old_string: 'only', new_string: 'x' }, solo);
      expect(got).toEqual({ commitShas: [g('rev-parse', 'HEAD')], prUrls: [] });
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  it('fails open to null on every unreadable case', async () => {
    const cases: Array<[string, HookInput | undefined, string]> = [
      ['no input', undefined, dir],
      ['no file_path', { old_string: 'line one', new_string: 'x' }, dir],
      ['missing file', { file_path: 'nope.js', old_string: 'x', new_string: 'y' }, dir],
      ['untracked file', { file_path: 'untracked.js', old_string: 'x', new_string: 'y' }, dir],
      ['old_string not in file', { file_path: 'a.js', old_string: 'absent text', new_string: 'y' }, dir],
      ['empty old_string', { file_path: 'a.js', old_string: '', new_string: 'y' }, dir],
      ['not a repo', { file_path: 'a.js', old_string: 'line one', new_string: 'x' }, tmpdir()],
      ['new file Write', { file_path: 'brand-new.js', content: 'x' }, dir],
    ];
    for (const [label, input, cwd] of cases) {
      expect(await findLineWriters(input, cwd), label).toBeNull();
    }
  });

  it('returns null for lines that are not committed yet', async () => {
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'sub', 'wip.js'), 'wip\n');
    git('add', 'sub/wip.js');
    expect(await findLineWriters({ file_path: 'sub/wip.js', old_string: 'wip', new_string: 'x' }, dir)).toBeNull();
  });

  it('gives up (null) when the blame exceeds its budget, instead of hanging the hook', async () => {
    const t0 = Date.now();
    const got = await findLineWriters({ file_path: 'a.js', old_string: 'line one', new_string: 'x' }, dir, { timeoutMs: 1 });
    expect(got).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

type HookInput = NonNullable<Parameters<typeof findLineWriters>[0]>;

describe('isWriterTitle', () => {
  it('excludes docs, style, test, chore, ci, build and release subjects, scoped or not, any case, with or without "!"', () => {
    for (const t of ['docs: x', 'docs(readme): move table (#4722)', 'Style(css): x', 'test: x', 'chore(deps): bump', 'ci: x', 'build!: x', 'RELEASE: 1.0']) {
      expect(isWriterTitle(t), t).toBe(false);
    }
  });

  it('keeps fix, feat, perf, refactor and untyped subjects, and words that merely start with a type', () => {
    for (const t of ['fix: clamp (#7089)', 'feat(core): x', 'perf: x', 'refactor: x', 'Add contributing.md', 'docs are great', 'testing: x', 'builder: x']) {
      expect(isWriterTitle(t), t).toBe(true);
    }
  });
});
