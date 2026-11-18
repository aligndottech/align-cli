/**
 * committableFromRepo reads a document path out of a source URL and asks git whether it is tracked.
 * Each case below is an input where a sloppy read would let private text into a committed file, or abort the sync.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { committableFromRepo, removeGitignoreLine } from '../lib/context-local-only.js';
import { writeDecisionsContext } from '../lib/decisions-context.js';

let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
const commit = () => git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
const put = (rel: string, text = '# x\n') => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'align-paths-')); git('init', '-q', '-b', 'main'); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('with a hosted remote', () => {
  beforeEach(() => { git('remote', 'add', 'origin', 'https://github.com/acme/api.git'); });

  it('reads the path after a branch name that contains a slash', () => {
    put('docs/adr/1.md'); git('add', '.'); commit(); git('checkout', '-q', '-b', 'feature/rules');
    expect(committableFromRepo([{ platform: 'docs', title: 'x', source_url: 'https://github.com/acme/api/blob/feature/rules/docs/adr/1.md' }], repo)).toBe(true);
  });

  it('matches the path literally, so [ab].md is not a.md', () => {
    put('docs/adr/a.md'); git('add', '.'); commit(); put('docs/adr/[ab].md');
    expect(committableFromRepo([{ platform: 'docs', title: 'x', source_url: 'https://github.com/acme/api/blob/main/docs/adr/[ab].md' }], repo)).toBe(false);
  });

  it('keeps a tracked doc private while it has uncommitted changes, since the file is read from the working tree', () => {
    put('docs/adr/1.md'); git('add', '.'); commit();
    const row = [{ platform: 'docs', title: 'x', source_url: 'https://github.com/acme/api/blob/main/docs/adr/1.md' }];
    expect(committableFromRepo(row, repo)).toBe(true);
    fs.appendFileSync(path.join(repo, 'docs/adr/1.md'), 'private draft\n');
    expect(committableFromRepo(row, repo)).toBe(false);
  });

  it("Align's own import line in CLAUDE.md is not an uncommitted edit, so a rerun before committing still writes the file", () => {
    put('CLAUDE.md', '# Rules\n\n## Tests for EO objects\n\nKeep the test inside the object.\n'); git('add', '.'); commit();
    const row = [{ platform: 'docs', title: 'Tests for EO objects', source_url: 'https://github.com/acme/api/blob/main/CLAUDE.md#tests-for-eo-objects' }];
    fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\n@DECISIONS.md\n');
    expect(committableFromRepo(row, repo)).toBe(true);
    fs.appendFileSync(path.join(repo, 'CLAUDE.md'), 'A private note about the acquisition\n');
    expect(committableFromRepo(row, repo)).toBe(false);
  });

  it('keeps a row private, rather than throwing, when its path has a bare %', () => {
    put('docs/adr/100%-coverage.md'); git('add', '.'); commit();
    expect(() => committableFromRepo([{ platform: 'docs', title: 'x', source_url: 'https://github.com/acme/api/blob/main/docs/adr/100%-coverage.md' }], repo)).not.toThrow();
  });
});

describe('a docs row is committable only when its own text is in the committed file', () => {
  beforeEach(() => { git('remote', 'add', 'origin', 'https://github.com/acme/api.git'); });
  const url = (p: string, ref = 'main') => `https://github.com/acme/api/blob/${ref}/${p}`;

  it('the title must be in the committed version, not only the path tracked (an import taken before the file was committed)', () => {
    put('docs/adr/1.md', '# Use Postgres for events\n'); git('add', '.'); commit();
    expect(committableFromRepo([{ platform: 'docs', title: 'Use Postgres for events', source_url: url('docs/adr/1.md') }], repo)).toBe(true);
    expect(committableFromRepo([{ platform: 'docs', title: 'Acquire Initech in Q3', source_url: url('docs/adr/1.md') }], repo)).toBe(false);
  });

  it('a %61 path that decodes onto a tracked a.md does not lend it a private title', () => {
    put('docs/adr/a.md', '# Public rule\n'); git('add', '.'); commit(); put('docs/adr/%61.md', '# Acquire Initech in Q3\n');
    expect(committableFromRepo([{ platform: 'docs', title: 'Acquire Initech in Q3', source_url: url('docs/adr/%61.md') }], repo)).toBe(false);
  });

  it('a branch renamed so the stored ref splits onto another tracked file does not lend it a private title', () => {
    put('adr/1.md', '# Public rule\n'); git('add', '.'); commit(); git('branch', '-m', 'main', 'saved'); git('checkout', '-q', '-b', 'main/docs');
    expect(committableFromRepo([{ platform: 'docs', title: 'Acquire Initech in Q3', source_url: url('docs/adr/1.md') }], repo)).toBe(false);
  });

  it('a title taken from the filename of a committed file with no heading counts', () => {
    put('docs/adr/0007-use-cockroachdb.md', 'We picked it for the multi-region writes.\n'); git('add', '.'); commit();
    expect(committableFromRepo([{ platform: 'docs', title: 'Use Cockroachdb', source_url: url('docs/adr/0007-use-cockroachdb.md') }], repo)).toBe(true);
  });
});

describe('with no hosted remote', () => {
  it("keeps a document private: a git:// URL does not say which repo it came from", () => {
    put('docs/adr/1.md'); git('add', '.'); commit();
    expect(committableFromRepo([{ platform: 'docs', title: 'x', source_url: 'git://blob/main/docs/adr/1.md' }], repo)).toBe(false);
  });

  it("accepts a commit that is in this repo's history, and not one that is not", () => {
    put('a.md'); git('add', '.'); commit();
    const sha = git('rev-parse', 'HEAD');
    expect(committableFromRepo([{ platform: 'git', source_url: `git://commit/${sha}` }], repo)).toBe(true);
    expect(committableFromRepo([{ platform: 'git', source_url: 'git://commit/0123456789abcdef0123456789abcdef01234567' }], repo)).toBe(false);
  });

  it('refuses a commit that exists in the object store but is not in the checked-out history (an unmerged branch, a deleted one)', () => {
    put('a.md'); git('add', '.'); commit();
    git('checkout', '-q', '-b', 'side'); put('private.md', 'secret\n'); git('add', '.'); commit();
    const onSide = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    const row = [{ platform: 'git', source_url: `git://commit/${onSide}` }];
    expect(committableFromRepo(row, repo)).toBe(false);
    // The commit is still there after its branch is deleted (until git prunes it), and still not in history.
    git('branch', '-D', 'side');
    expect(git('cat-file', '-t', onSide)).toBe('commit');
    expect(committableFromRepo(row, repo)).toBe(false);
    // Control: the same commit counts once HEAD contains it.
    git('merge', '-q', '--ff-only', onSide);
    expect(committableFromRepo(row, repo)).toBe(true);
  });
});

describe('a failed write leaves no temporary file behind to be committed', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('removeGitignoreLine', () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.align/decisions.md\n');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => removeGitignoreLine(repo, '.align/decisions.md')).toThrow('disk full');
    expect(fs.readdirSync(repo).filter((f) => f.includes('align-tmp'))).toEqual([]);
  });
  it('writeDecisionsContext', async () => {
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(writeDecisionsContext(repo, [{ title: 'Use Postgres' }])).rejects.toThrow('disk full');
    expect(fs.readdirSync(path.join(repo, '.align')).filter((f) => f.includes('align-tmp'))).toEqual([]);
  });
});
