/**
 * `align adr`: write an ADR into the repo for a decision that was made in a commit, a PR or a ticket and never got one.
 * Asked for by a user who expects a decisions tool to maintain the ADRs inside the git repo.
 *
 * Test List:
 * 1. the ADR folder is the repo's own (the first convention that exists), else docs/adr
 * 2. the next number follows the highest existing ADR and keeps its width (two examples: 0012 -> 0013, empty -> 0001)
 * 3. the ADR carries the title, Accepted, the stated reason and a link to where it was decided, and nothing invented
 * 4. a decision whose source an existing ADR already links to is not proposed again
 * 5. writing never overwrites a file, and creates the folder when there is none
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adrCandidates, adrDirFor, nextAdrNumber, renderAdr, writeAdr } from '../lib/adr-writer.js';

let repo: string;
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'align-adr-')); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });
const put = (rel: string, text = '# x\n') => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };

describe('adrDirFor', () => {
  it('uses the folder the repo already keeps its ADRs in', () => {
    put('docs/decisions/0001-use-postgres.md');
    expect(adrDirFor(repo)).toBe('docs/decisions');
  });
  it('defaults to docs/adr when the repo has none', () => {
    expect(adrDirFor(repo)).toBe('docs/adr');
  });
});

describe('nextAdrNumber', () => {
  it('follows the highest existing ADR and keeps its width', () => {
    put('docs/adr/0007-a.md'); put('docs/adr/0012-b.md'); put('docs/adr/README.md');
    expect(nextAdrNumber(path.join(repo, 'docs/adr'))).toBe('0013');
  });
  it('starts at 0001 in an empty or missing folder', () => {
    expect(nextAdrNumber(path.join(repo, 'docs/adr'))).toBe('0001');
  });
});

describe('renderAdr', () => {
  it('carries the title, Accepted, the stated reason and the source link, and invents nothing', () => {
    const text = renderAdr({
      number: '0013', title: 'Replace eo-inference with the per-copy engine', date: '2026-11-02',
      reason: 'the per-copy engine resolves each copy once, so inference stops repeating work',
      excerpt: 'Replace eo-inference with the per-copy engine\n\nThe old engine re-read every copy.',
      sourceUrl: 'https://github.com/objectionary/eo/commit/9d90b52',
    });
    expect(text).toMatch(/^# 13\. Replace eo-inference with the per-copy engine\n/);
    expect(text).toContain('Date: 2026-11-02');
    expect(text).toMatch(/## Status\n\nAccepted/);
    expect(text).toContain('the per-copy engine resolves each copy once');
    expect(text).toContain('https://github.com/objectionary/eo/commit/9d90b52');
    expect(text).toContain('The old engine re-read every copy.');
    // No consequences were stated in the source, so the section says so rather than making some up.
    expect(text).toMatch(/## Consequences\n\nNot recorded in the source/);
  });
});

describe('adrCandidates', () => {
  it('leaves out a decision an existing ADR already links to', () => {
    put('docs/adr/0001-engine.md', '# 1. Engine\n\nDecided in https://github.com/o/r/commit/aaa1111\n');
    const rows = [
      { title: 'Replace the old engine with the per-copy engine', platform: 'git', summary: '', source_url: 'https://github.com/o/r/commit/aaa1111' },
      { title: 'Encode TRUE as FF- instead of 01-', platform: 'git', summary: '', source_url: 'https://github.com/o/r/commit/bbb2222' },
    ];
    expect(adrCandidates(rows, repo).map((c) => c.title)).toEqual(['Encode TRUE as FF- instead of 01-']);
  });
});

describe('writeAdr', () => {
  it('creates the folder, writes the next number, and never overwrites', () => {
    const c = { title: 'Encode TRUE as FF- instead of 01-', sourceUrl: 'https://github.com/o/r/commit/bbb2222', excerpt: 'x' };
    const first = writeAdr(repo, c, '2026-11-18');
    expect(first).toBe('docs/adr/0001-encode-true-as-ff-instead-of-01.md');
    expect(fs.readFileSync(path.join(repo, first), 'utf8')).toContain('Encode TRUE as FF- instead of 01-');
    const second = writeAdr(repo, { ...c, title: 'Require an argument on +alias' }, '2026-11-18');
    expect(second).toBe('docs/adr/0002-require-an-argument-on-alias.md');
    // A file at the exact target is never replaced.
    fs.writeFileSync(path.join(repo, 'docs/adr/0003-require-an-argument-on-alias.md'), 'mine');
    expect(() => writeAdr(repo, { ...c, title: 'Require an argument on +alias' }, '2026-11-18', { number: '0003' })).toThrow();
    expect(fs.readFileSync(path.join(repo, 'docs/adr/0003-require-an-argument-on-alias.md'), 'utf8')).toBe('mine');
  });
});
