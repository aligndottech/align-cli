import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChoiceKey } from '../lib/run-choice-key.js';

// A REAL git repo and a REAL worktree: the key must not depend on a mock of the root.
let base: string;
let repo: string;
let sub: string;
let wt: string;
let plain: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-key-')));
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
    expect(await runChoiceKey(plain)).toBe(plain);
  });
});
