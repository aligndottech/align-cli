import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { formatCommitAsText, getCommitHistory, unquoteGitPath } from '../lib/git.js';

/**
 * The stored commit text lists the files a commit touched, bounded so one huge commit
 * cannot bloat a decision. The bound used to be the FIRST 10 paths in git's alphabetical order, so
 * a commit of many docs plus one source file lost the source file - the one path that says what
 * the decision was about.
 */
const SEP = '\x1f';
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const FILES_SHOWN = 10;

const logOf = (files: string[]) =>
  [`COMMIT${SEP}${SHA}${SEP}feat(auth): switch to JWT for stateless sessions${SEP}Tom${SEP}2026-05-01T10:00:00Z${SEP}We chose JWT because sessions need sticky routing.${SEP}END`, '', ...files].join('\n');

const filesOf = async (files: string[]) => {
  vi.mocked(execa).mockResolvedValueOnce({ stdout: logOf(files), stderr: '' } as Awaited<ReturnType<typeof execa>>);
  const [commit] = await getCommitHistory({});
  return commit!;
};

const docs = (n: number) => Array.from({ length: n }, (_, i) => `docs/page-${String(i).padStart(2, '0')}.md`);

describe('commit file list under the cap', () => {
  it('lists every file when a commit touches no more than the cap', async () => {
    const files = [...docs(FILES_SHOWN - 1), 'src/auth.ts'];
    const c = await filesOf(files);
    expect(c.filesChanged).toEqual(files);
    expect(c.filesOmitted).toBeUndefined();
    expect(formatCommitAsText(c)).not.toMatch(/more file/);
  });

  it('keeps the one source file when a commit of many docs is capped', async () => {
    const c = await filesOf([...docs(25), 'src/auth.ts']);
    expect(c.filesChanged).toContain('src/auth.ts');
    expect(c.filesChanged).toHaveLength(FILES_SHOWN);
  });

  it('keeps the source file wherever git listed it (first or last)', async () => {
    const first = await filesOf(['src/a.ts', ...docs(25)]);
    const last = await filesOf([...docs(25), 'zzz/last.ts']);
    expect(first.filesChanged).toContain('src/a.ts');
    expect(last.filesChanged).toContain('zzz/last.ts');
  });

  it('puts source files ahead of docs, lockfiles and generated files', async () => {
    const c = await filesOf(['README.md', 'package-lock.json', 'dist/bundle.js', 'src/b.ts', 'src/a.ts', ...docs(20)]);
    expect(c.filesChanged.slice(0, 2)).toEqual(['src/b.ts', 'src/a.ts']);
  });

  it('reads paths git C-quotes (non-ASCII names) as the real path', async () => {
    // core.quotePath (on by default) writes docs/page-é-0.md as "docs/page-\303\251-0.md".
    const quoted = Array.from({ length: 12 }, (_, i) => `"docs/page-\\303\\251-${i}.md"`);
    const c = await filesOf([...quoted, 'src/auth.ts']);
    expect(c.filesChanged).toContain('src/auth.ts');
    expect(c.filesChanged).toContain('docs/page-\u00e9-0.md');
  });

  it('says how many were left out, in the data and in the stored text', async () => {
    const c = await filesOf([...docs(25), 'src/auth.ts']);
    expect(c.filesOmitted).toBe(26 - FILES_SHOWN);
    expect(formatCommitAsText(c)).toContain(`Files changed:\n${c.filesChanged.join('\n')}\n+${26 - FILES_SHOWN} more files`);
  });

  it('says "1 more file" in the singular', async () => {
    const c = await filesOf([...docs(FILES_SHOWN), 'src/auth.ts']);
    expect(c.filesOmitted).toBe(1);
    expect(formatCommitAsText(c)).toContain('+1 more file');
    expect(formatCommitAsText(c)).not.toContain('+1 more files');
  });

  it('treats source under a nested build/, doc/ or out/ directory as source, and a root dist/ as generated', async () => {
    const nested = ['src/build/compile.ts', 'tools/build/x.ts', 'src/doc/parser.ts', 'src/out/emit.ts'];
    const c = await filesOf([...docs(20), 'dist/bundle.js', ...nested]);
    expect(c.filesChanged.slice(0, 4)).toEqual(nested);
    expect(c.filesChanged).not.toContain('dist/bundle.js');
  });
});


describe('unquoteGitPath', () => {
  it('decodes the escapes git writes and leaves an unquoted path alone', () => {
    expect(unquoteGitPath('"docs/caf\\303\\251.md"')).toBe('docs/caf\u00e9.md');
    expect(unquoteGitPath('"a\\"b\\\\c\\td.ts"')).toBe('a"b\\c\td.ts');
    expect(unquoteGitPath('"emoji-\\360\\237\\232\\200.ts"')).toBe('emoji-\u{1F680}.ts');
    expect(unquoteGitPath('src/plain.ts')).toBe('src/plain.ts');
    expect(unquoteGitPath('"raw-\u{1F680}.ts"')).toBe('raw-\u{1F680}.ts');
  });
});
