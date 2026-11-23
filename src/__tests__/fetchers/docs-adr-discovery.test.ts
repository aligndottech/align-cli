import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 *  A8 a file reachable by both routes is imported once
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
    writeFileSync(join(repo, rel), `# ${rel}\n\n${body}`);
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
    expect(urls(items)).toEqual([
      '.specs/project/ADRs/0001-c.md', '.specs/project/ADRs/0002-d.md',
      'adda/DECISIONS/0001-a.md', 'adda/DECISIONS/0002-b.md',
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

  it('A8 a dir found by both routes is read once', async () => {
    fresh();
    put('docs/adr/0001-a.md');
    put('docs/adr/0002-b.md');
    put('x/adr/0001-c.md');
    put('x/adr/0002-d.md');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    const u = urls(items);
    expect(new Set(u).size).toBe(u.length);
    expect(u).toHaveLength(4);
  });
});
