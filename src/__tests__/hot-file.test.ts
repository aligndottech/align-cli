import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { getHotFile, pickHotFile } from '../lib/hot-file.js';

/**
 * The outro's "what was decided about <file>?" names the file the user is most likely to
 * touch next: the one changed most often in recent history. Release bookkeeping and docs
 * change often and carry no design, so they are skipped.
 */
describe('pickHotFile', () => {
  const all = () => true;

  it('picks the most often changed file', () => {
    expect(pickHotFile(['src/a.ts', 'src/b.ts', 'src/b.ts', 'src/c.ts'], all)).toBe('src/b.ts');
  });

  it('skips lockfiles, changelogs, markdown and release manifests, which churn without design', () => {
    const names = [
      ...Array(9).fill('package-lock.json'),
      ...Array(9).fill('package.json'),
      ...Array(9).fill('CHANGELOG.md'),
      ...Array(9).fill('docs/guide.md'),
      ...Array(9).fill('.release-please-manifest.json'),
      ...Array(9).fill('yarn.lock'),
      'src/x.ts',
    ];
    expect(pickHotFile(names, all)).toBe('src/x.ts');
  });

  it('skips tests, so the question names the code under them', () => {
    expect(pickHotFile(['src/__tests__/a.test.ts', 'src/__tests__/a.test.ts', 'src/a.spec.ts', 'src/a.spec.ts', 'src/a.ts'], all)).toBe('src/a.ts');
  });

  it('skips a file that no longer exists', () => {
    expect(pickHotFile(['gone.ts', 'gone.ts', 'here.ts'], (p) => p === 'here.ts')).toBe('here.ts');
  });

  it('breaks ties by first seen, which is the most recent', () => {
    expect(pickHotFile(['new.ts', 'old.ts'], all)).toBe('new.ts');
  });

  it('is undefined when nothing qualifies', () => {
    expect(pickHotFile([], all)).toBeUndefined();
    expect(pickHotFile(['README.md'], all)).toBeUndefined();
  });
});

describe('getHotFile', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  async function commit(cwd: string, file: string, body: string) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), body);
    await execa('git', ['add', '.'], { cwd });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', `touch ${file}`], { cwd });
  }

  it('reads the most changed file from a real repo, as a repo-relative path', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'align-hot-'));
    await execa('git', ['init', '-q'], { cwd: dir });
    await commit(dir, 'src/db.ts', '1');
    await commit(dir, 'src/db.ts', '2');
    await commit(dir, 'src/other.ts', '1');
    await commit(dir, 'README.md', '1');
    expect(await getHotFile({ cwd: dir })).toBe('src/db.ts');
  });

  it('is undefined outside a git repo, never a throw', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'align-hot-'));
    expect(await getHotFile({ cwd: dir })).toBeUndefined();
  });
});
