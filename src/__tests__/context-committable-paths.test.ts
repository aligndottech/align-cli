/**
 * committableFromRepo reads a document path out of a source URL and asks git whether it is tracked.
 * Each case below is an input where a sloppy read would let private text into a committed file, or abort the sync.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { committableFromRepo } from '../lib/context-local-only.js';

let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
const commit = () => git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), '# x\n'); };
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'align-paths-')); git('init', '-q', '-b', 'main'); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('with a hosted remote', () => {
  beforeEach(() => { git('remote', 'add', 'origin', 'https://github.com/acme/api.git'); });

  it('reads the path after a branch name that contains a slash', () => {
    put('docs/adr/1.md'); git('add', '.'); commit(); git('checkout', '-q', '-b', 'feature/rules');
    expect(committableFromRepo([{ platform: 'docs', source_url: 'https://github.com/acme/api/blob/feature/rules/docs/adr/1.md' }], repo)).toBe(true);
  });

  it('matches the path literally, so [ab].md is not a.md', () => {
    put('docs/adr/a.md'); git('add', '.'); commit(); put('docs/adr/[ab].md');
    expect(committableFromRepo([{ platform: 'docs', source_url: 'https://github.com/acme/api/blob/main/docs/adr/[ab].md' }], repo)).toBe(false);
  });

  it('keeps a row private, rather than throwing, when its path has a bare %', () => {
    put('docs/adr/100%-coverage.md'); git('add', '.'); commit();
    expect(() => committableFromRepo([{ platform: 'docs', source_url: 'https://github.com/acme/api/blob/main/docs/adr/100%-coverage.md' }], repo)).not.toThrow();
  });
});

describe('with no hosted remote', () => {
  it("keeps a document private: a git:// URL does not say which repo it came from", () => {
    put('docs/adr/1.md'); git('add', '.'); commit();
    expect(committableFromRepo([{ platform: 'docs', source_url: 'git://blob/main/docs/adr/1.md' }], repo)).toBe(false);
  });

  it("accepts a commit that is in this repo's history, and not one that is not", () => {
    put('a.md'); git('add', '.'); commit();
    const sha = git('rev-parse', 'HEAD');
    expect(committableFromRepo([{ platform: 'git', source_url: `git://commit/${sha}` }], repo)).toBe(true);
    expect(committableFromRepo([{ platform: 'git', source_url: 'git://commit/0123456789abcdef0123456789abcdef01234567' }], repo)).toBe(false);
  });
});
