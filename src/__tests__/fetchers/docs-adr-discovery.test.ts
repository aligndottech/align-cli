import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { fetchDocsItems } from '../../lib/fetchers/docs.js';

/**
 * ADR directories anywhere in the tree. Test List:
 *  A1 adda-style adda/DECISIONS/0001-x.md imports                    (two examples: also .specs/project/ADRs)
 *  A2 a directory name matches case-insensitively (`Decisions`)
 *  A3 a `decisions/` dir with notes and no numbered or dated files is NOT an ADR dir
 *  A4 a dir with only one record file is NOT an ADR dir
 *  A5 node_modules/**\/adr and a .gitignore'd dir are never read
 *  A6 a repo on the candidate list behaves as before (no discovery note)
 *  A7 at most 5 discovered dirs are read, and the report says which
 *  A8 a candidate dir reached again by a symlink alias does not take a discovery slot (see test)
 *  B1 .claude worktree copies, B2 fixtures/test dirs, B3 dated standup notes (no Status/Decision content),
 *  B4 .svelte-kit output are never ADR dirs
 *  B5 the cap keeps the shallow real dir over deeper noisy ones
 *  B6 limit: candidate files first, scope note names only dirs that contributed
 *  B7 an unreadable file is skipped and counted; B8 a truncated walk says so; B9 `**\/gen` matches a top-level gen
 */
function mockGit(): void {
  vi.mocked(execa).mockImplementation(async (_cmd, args) => {
    const a = args as string[];
    if (a[0] === 'remote') return { stdout: 'https://github.com/org/repo.git' } as Awaited<ReturnType<typeof execa>>;
    if (a[0] === 'rev-parse') return { stdout: 'main' } as Awaited<ReturnType<typeof execa>>;
    throw new Error(`unexpected git invocation: ${a.join(' ')}`);
  });
}

describe('fetchDocsItems - ADR directories found by name anywhere', () => {
  let repo: string;
  afterEach(() => {
    vi.clearAllMocks();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  function put(rel: string, body = 'A decision with enough text to keep.'): void {
    mkdirSync(join(repo, dirname(rel)), { recursive: true });
    writeFileSync(join(repo, rel), `# ${rel}\n\nStatus: Accepted\n\n## Decision\n${body}`);
  }
  function fresh(): void {
    repo = mkdtempSync(join(tmpdir(), 'align-adrdirs-'));
    mockGit();
  }
  const urls = (items: Array<{ source_url: string }>) => items.map((i) => i.source_url.replace('https://github.com/org/repo/blob/main/', ''));

  it('A1 reads adda/DECISIONS/ and .specs/project/ADRs', async () => {
    fresh();
    put('adda/DECISIONS/0001-a.md');
    put('adda/DECISIONS/0002-b.md');
    put('.specs/project/ADRs/0001-c.md');
    put('.specs/project/ADRs/0002-d.md');
    const { items, report } = await fetchDocsItems({ limit: 100, cwd: repo });
    // Discovered dirs come in rank order: shallower first.
    expect(urls(items)).toEqual([
      'adda/DECISIONS/0001-a.md', 'adda/DECISIONS/0002-b.md',
      '.specs/project/ADRs/0001-c.md', '.specs/project/ADRs/0002-d.md',
    ]);
    expect(report.scopeNote).toContain('adda/DECISIONS');
    expect(report.scopeNote).toContain('.specs/project/ADRs');
  });

  it('A2 matches the directory name case-insensitively and accepts dated and ADR- prefixed names', async () => {
    fresh();
    put('knowledge/Decisions/2026-09-24-pick-queue.md');
    put('knowledge/Decisions/ADR-0012-pick-db.md');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(urls(items)).toEqual(['knowledge/Decisions/2026-09-24-pick-queue.md', 'knowledge/Decisions/ADR-0012-pick-db.md']);
  });

  it('A3 a decisions/ dir of plain notes is not an ADR dir', async () => {
    fresh();
    put('notes/decisions/meeting-notes.md');
    put('notes/decisions/ideas.md');
    put('notes/decisions/README.md');
    const { items, report } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items).toEqual([]);
    expect(report.scopeNote).toBeUndefined();
  });

  it('A4 one numbered file beside a README and a template is not enough', async () => {
    fresh();
    put('project/adr/0001-only.md');
    put('project/adr/README.md');
    put('project/adr/0000-template.md');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items).toEqual([]);
  });

  it('A5 skips node_modules and gitignored directories', async () => {
    fresh();
    put('node_modules/pkg/adr/0001-a.md');
    put('node_modules/pkg/adr/0002-b.md');
    put('generated/decisions/0001-a.md');
    put('generated/decisions/0002-b.md');
    writeFileSync(join(repo, '.gitignore'), 'generated/\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items).toEqual([]);
  });

  it('A6 a repo whose ADRs sit on the candidate list reports no discovery', async () => {
    fresh();
    put('docs/adr/0001-a.md');
    put('docs/adr/0002-b.md');
    const { items, report } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(urls(items)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0002-b.md']);
    expect(report.scopeNote).toBeUndefined();
  });

  it('A7 reads at most 5 discovered dirs and names the ones it left out', async () => {
    fresh();
    for (const d of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      put(`${d}/adr/0001-x.md`);
      put(`${d}/adr/0002-y.md`);
    }
    const { items, report } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items).toHaveLength(10);
    expect(urls(items).some((u) => u.startsWith('f/') || u.startsWith('g/'))).toBe(false);
    expect(report.scopeNote).toContain('a/adr');
    expect(report.scopeNote).toMatch(/2 more/);
  });

  it('A8 a candidate dir reached through a symlink alias is not counted again by discovery', async (ctx) => {
    fresh();
    // a0/adr is a real dir that sorts first; docs/adr (a candidate) is a symlink to it.
    put('a0/adr/0001-a.md');
    put('a0/adr/0002-b.md');
    for (const d of ['b', 'c', 'd', 'e', 'f']) {
      put(`${d}/adr/0001-x.md`);
      put(`${d}/adr/0002-y.md`);
    }
    mkdirSync(join(repo, 'docs'), { recursive: true });
    try {
      symlinkSync(join(repo, 'a0', 'adr'), join(repo, 'docs', 'adr'), 'dir');
    } catch (e) {
      ctx.skip(`cannot create a symlink on this platform: ${(e as Error).message}`);
    }
    const { items, report } = await fetchDocsItems({ limit: 100, cwd: repo });
    const u = urls(items);
    expect(new Set(u).size).toBe(u.length);
    // Without the seen-real check a0/adr takes the first discovery slot and f/adr is left out.
    expect(u.filter((x) => x.startsWith('f/'))).toHaveLength(2);
    expect(report.scopeNote ?? '').not.toMatch(/more not read/);
  });

  describe('junk directories and record content', () => {
    const none = async () => (await fetchDocsItems({ limit: 100, cwd: repo }));
    const pair = (dir: string, body?: string) => { put(`${dir}/0001-a.md`, body); put(`${dir}/0002-b.md`, body); };

    it('B1 a .claude worktree copy of the docs is not read', async () => {
      fresh();
      pair('.claude/worktrees/w1/docs/foo/adr');
      expect((await none()).items).toEqual([]);
    });

    it('B2 test and fixtures directories are not read', async () => {
      fresh();
      pair('test/fixtures/repo/adr');
      pair('fixtures/x/adr');
      pair('examples/demo/decisions');
      expect((await none()).items).toEqual([]);
    });

    it('B3 dated standup notes in a decisions/ dir are not records', async () => {
      fresh();
      writeFileSync(join(repo, '.keep'), '');
      for (const n of ['2026-01-05-standup.md', '2026-01-06-standup.md']) {
        mkdirSync(join(repo, 'decisions'), { recursive: true });
        writeFileSync(join(repo, 'decisions', n), '# Standup\n\nAttendees: a, b\nNotes: shipped the thing, blocked on review\n');
      }
      const { items, report } = await none();
      expect(items).toEqual([]);
      expect(report.scopeNote).toBeUndefined();
    });

    it('B3b one record plus one standup note is still not enough', async () => {
      fresh();
      put('decisions/0001-real.md');
      mkdirSync(join(repo, 'decisions'), { recursive: true });
      writeFileSync(join(repo, 'decisions/0002-standup.md'), '# Standup\n\nShipped the thing.\n');
      expect((await none()).items).toEqual([]);
    });

    it('B4 .svelte-kit output is not read', async () => {
      fresh();
      pair('.svelte-kit/output/adr');
      expect((await none()).items).toEqual([]);
    });

    it('B5 the cap keeps a shallow real dir over deeper noisy ones', async () => {
      fresh();
      for (const d of ['n1', 'n2', 'n3', 'n4', 'n5']) pair(`${d}/x/y/adr`);
      pair('services/api/adr');
      const { items } = await none();
      expect(urls(items)).toContain('services/api/adr/0001-a.md');
    });

    it('B6 candidate files fill the limit first and the note names only dirs that contributed', async () => {
      fresh();
      put('docs/adr/0001-a.md');
      put('docs/adr/0002-b.md');
      put('docs/adr/0003-c.md');
      pair('aaa/adr');
      const { items, report } = await fetchDocsItems({ limit: 3, cwd: repo });
      expect(urls(items)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0002-b.md', 'docs/adr/0003-c.md']);
      expect(report.scopeNote).not.toMatch(/directories found by name: aaa/);
      expect(report.scopeNote).toMatch(/cut by the limit: aaa\/adr/);
    });

    it('B6b when the limit leaves room, discovered files follow and the note names the dir', async () => {
      fresh();
      pair('docs/adr');
      pair('zzz/adr');
      const { items, report } = await fetchDocsItems({ limit: 4, cwd: repo });
      expect(urls(items)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0002-b.md', 'zzz/adr/0001-a.md', 'zzz/adr/0002-b.md']);
      expect(report.scopeNote).toContain('found by name: zzz/adr');
    });

    it('B7 an unreadable file is skipped, the rest import, and the note counts it', async (ctx) => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) ctx.skip('running as root: chmod 000 does not block reads');
      fresh();
      pair('docs/adr');
      put('docs/adr/0003-c.md');
      chmodSync(join(repo, 'docs/adr/0002-b.md'), 0);
      const { items, report } = await none();
      expect(urls(items)).toEqual(['docs/adr/0001-a.md', 'docs/adr/0003-c.md']);
      expect(report.scopeNote).toMatch(/1 unreadable ADR file skipped/);
    });

    it('B7b an unreadable file in a discovered dir is skipped and counted once', async (ctx) => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) ctx.skip('running as root: chmod 000 does not block reads');
      fresh();
      pair('knowledge/adr');
      put('knowledge/adr/0003-c.md');
      chmodSync(join(repo, 'knowledge/adr/0001-a.md'), 0);
      const { items, report } = await none();
      expect(urls(items)).toEqual(['knowledge/adr/0002-b.md', 'knowledge/adr/0003-c.md']);
      expect(report.scopeNote).toMatch(/1 unreadable ADR file skipped/);
    });

    it('B8 a walk cut by the directory budget says so', async () => {
      fresh();
      for (let i = 0; i < 4100; i++) mkdirSync(join(repo, `pkg${String(i).padStart(5, '0')}`));
      pair('zz/adr');
      const { report } = await none();
      expect(report.scopeNote).toMatch(/scan stopped at 4000 dirs/);
    });

    it('B8b a walk that skipped directories below the depth limit says so', async () => {
      fresh();
      pair('a/b/c/d/e/f/g/h');
      const { report } = await none();
      expect(report.scopeNote).toMatch(/deeper than 6 levels not scanned/);
    });

    it('B9 `**/gen` in .gitignore also excludes a top-level gen', async () => {
      fresh();
      writeFileSync(join(repo, '.gitignore'), '**/gen\n');
      pair('gen/adr');
      pair('a/gen/adr');
      expect((await none()).items).toEqual([]);
    });
  });
});
