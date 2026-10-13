import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureGitignored, isTrackedByGit } from '../context-local-only.js';

// `align context sync` writes decision titles and source links into a file in the repo. From a LOCAL graph that
// graph is private (built with personal tokens), and a committed copy would hand it to every colleague and every
// agent in the repo without a share's preview, secret scan or consent. These pin the two small helpers that keep
// that file on the machine and say so when it is already in git.
const FILE = '.align/decisions.md';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });

describe('ensureGitignored', () => {
  it('no .gitignore: creates one holding the path', () => {
    expect(ensureGitignored(dir, FILE)).toBe('added');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(`${FILE}\n`);
  });

  it('an existing .gitignore keeps its lines, with or without a trailing newline (two examples)', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    ensureGitignored(dir, FILE);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(`node_modules/\n${FILE}\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist');
    ensureGitignored(dir, FILE);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(`dist\n${FILE}\n`);
  });

  it('already ignored is left byte for byte, however it is spelled', () => {
    for (const spelling of [FILE, `/${FILE}`, '.align/', '/.align/', '.align', '.align/*']) {
      fs.writeFileSync(path.join(dir, '.gitignore'), `a\n${spelling}\nb\n`);
      expect(ensureGitignored(dir, FILE)).toBe('already');
      expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(`a\n${spelling}\nb\n`);
    }
  });

  it('a different .align path is not the same file: still added', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.align/other.md\n');
    expect(ensureGitignored(dir, FILE)).toBe('added');
  });

  it('running twice adds it once', () => {
    ensureGitignored(dir, FILE);
    expect(ensureGitignored(dir, FILE)).toBe('already');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(`${FILE}\n`);
  });
});

describe('isTrackedByGit', () => {
  it('true once the file is committed, false while it is untracked (two examples)', () => {
    git('init', '-q');
    fs.mkdirSync(path.join(dir, '.align'));
    fs.writeFileSync(path.join(dir, FILE), 'x');
    expect(isTrackedByGit(dir, FILE)).toBe(false);
    git('add', FILE);
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
    expect(isTrackedByGit(dir, FILE)).toBe(true);
  });

  it('not a git repo is false, never a throw', () => {
    expect(isTrackedByGit(dir, FILE)).toBe(false);
  });
});
