import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { formatCommitAsText, getCommitHistory } from '../lib/git.js';

/**
 * ALI-2100: the stored commit text lists the files a commit touched, bounded so one huge commit
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
});
