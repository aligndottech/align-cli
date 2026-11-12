import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeRepoPath, runChoiceKey } from '../lib/run-choice-key.js';

// A REAL git repo and a REAL worktree: the key must not depend on a mock of the root.
let base: string;
let repo: string;
let sub: string;
let wt: string;
let plain: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });

beforeAll(() => {
  // The expected keys are spelled through the same normaliser, never from a raw tmpdir string:
  // on Windows tmpdir is an 8.3 short backslash path and git answers with a long forward-slash one.
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'align-key-')));
  repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  sub = path.join(repo, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  wt = path.join(base, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'other');
  plain = path.join(base, 'plain');
  mkdirSync(plain);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('runChoiceKey', () => {
  it('is the repository root for a normal repo', async () => {
    expect(await runChoiceKey(repo)).toBe(repo);
  });
  it('is the same from a subdirectory', async () => {
    expect(await runChoiceKey(sub)).toBe(repo);
  });
  it('is the same from a git worktree of that repo', async () => {
    expect(await runChoiceKey(wt)).toBe(repo);
  });
  it('is the folder itself outside git', async () => {
    expect(await runChoiceKey(plain)).toBe(normalizeRepoPath(plain));
  });
});

describe('normalizeRepoPath: one key for one folder, whatever spelling arrives', () => {
  it('maps forward-slash, trailing-separator and dot-dot spellings of an existing dir to one key', () => {
    const key = normalizeRepoPath(repo);
    expect(normalizeRepoPath(repo.split(path.sep).join('/'))).toBe(key);
    expect(normalizeRepoPath(`${repo}${path.sep}`)).toBe(key);
    expect(normalizeRepoPath(path.join(repo, 'a', '..'))).toBe(key);
  });
  it.skipIf(process.platform !== 'win32')('maps a backslash spelling, a short 8.3 spelling and a lower-case drive letter to one key (win32)', () => {
    const key = normalizeRepoPath(repo);
    expect(normalizeRepoPath(repo.split('/').join('\\'))).toBe(key);
    expect(normalizeRepoPath(os.tmpdir() + repo.slice(realpathSync.native(os.tmpdir()).length))).toBe(key);
    expect(normalizeRepoPath(repo[0]!.toLowerCase() + repo.slice(1))).toBe(key);
  });
  it('falls back to a plain resolve for a path that does not exist', () => {
    const gone = path.join(base, 'nope', 'x');
    expect(normalizeRepoPath(gone)).toBe(path.resolve(gone));
  });
});
