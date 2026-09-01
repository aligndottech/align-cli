import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { fetchDocsItems } from '../../lib/fetchers/docs.js';

/**
 * ALI-793: read what the repo already wrote down - ADR directories (the common naming
 * conventions) and the user's own CLAUDE.md/AGENTS.md content, minus the marker block and
 * import line Align itself wrote there (align-cli#116: Align owns `.align/` outright and
 * must never re-ingest its own output).
 *
 * Real filesystem, no mocked fs - readFile/readdir over a throwaway temp repo is cheap and
 * catches path-join bugs a mocked fs cannot. `execa` is mocked because these tests don't
 * need real git, only a stable remote/branch answer to exercise buildBlobUrl (git.test.ts
 * already pins that function's own behaviour).
 */
function mockGit(remoteUrl: string | null, branch = 'main'): void {
  vi.mocked(execa).mockImplementation(async (_cmd, args) => {
    const a = args as string[];
    if (a[0] === 'remote') {
      if (remoteUrl === null) throw new Error('no remote');
      return { stdout: remoteUrl } as Awaited<ReturnType<typeof execa>>;
    }
    if (a[0] === 'rev-parse') return { stdout: branch } as Awaited<ReturnType<typeof execa>>;
    throw new Error(`unexpected git invocation: ${a.join(' ')}`);
  });
}

describe('fetchDocsItems - ADR directories', () => {
  let repo: string;
  afterEach(() => {
    vi.clearAllMocks();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('reads an ADR from docs/adr, using the H1 heading as the title', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true });
    writeFileSync(
      join(repo, 'docs', 'adr', '0001-use-postgres.md'),
      '# 1. Use Postgres\n\nStatus: Accepted\n\nWe need a relational store with strong consistency.',
    );
    mockGit('https://github.com/org/repo.git');

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: '1. Use Postgres', platform: 'docs' });
    expect(items[0].raw_text).toContain('Status: Accepted');
    expect(items[0].source_url).toBe('https://github.com/org/repo/blob/main/docs/adr/0001-use-postgres.md');
  });

  it('also reads doc/adr (the singular-doc convention), alongside docs/adr in the same repo', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true });
    mkdirSync(join(repo, 'doc', 'adr'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'adr', '0001-a.md'), '# Decision A\n\nBecause reasons that are long enough.');
    writeFileSync(join(repo, 'doc', 'adr', '0002-b.md'), '# Decision B\n\nBecause other reasons, also long enough.');
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items.map((i) => i.title).sort()).toEqual(['Decision A', 'Decision B']);
  });

  it('reads docs/decisions and root-level adr/', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
    mkdirSync(join(repo, 'adr'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'decisions', '1.md'), '# Decisions dir ADR\n\nLong enough body text here.');
    writeFileSync(join(repo, 'adr', '1.md'), '# Root adr dir ADR\n\nLong enough body text here too.');
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items.map((i) => i.title).sort()).toEqual(['Decisions dir ADR', 'Root adr dir ADR']);
  });

  it('returns no ADR items, without throwing, when the repo has no ADR directory', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mockGit(null);

    await expect(fetchDocsItems({ limit: 100, cwd: repo })).resolves.toEqual([]);
  });

  it('falls back to a humanized filename when the ADR has no H1 heading', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'adr', '0007-use-cockroachdb.md'), 'Status: Proposed\n\nNo heading in this one.');
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items[0].title).toBe('Use Cockroachdb');
  });

  it('preserves a "Superseded by" status line verbatim, so the graph can pick up the supersession from the text', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true });
    writeFileSync(
      join(repo, 'docs', 'adr', '0001-old.md'),
      '# 1. Old approach\n\nStatus: Superseded by 0007-use-cockroachdb.md\n\nWe once decided this, no longer current.',
    );
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items[0].raw_text).toContain('Superseded by 0007-use-cockroachdb.md');
  });

  it('falls back to a stable git:// identifier when there is no known remote (never throws, never calls the network)', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'adr', '0001-a.md'), '# Decision A\n\nBecause reasons that are long enough.');
    mockGit(null, 'main');

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items[0].source_url).toBe('git://blob/main/docs/adr/0001-a.md');
  });
});

describe('fetchDocsItems - CLAUDE.md / AGENTS.md', () => {
  let repo: string;
  afterEach(() => {
    vi.clearAllMocks();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('imports a real section of CLAUDE.md as a decision candidate', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      [
        '# My Project',
        '',
        '## Database',
        '',
        'We use Postgres with row-level security for every tenant-scoped table.',
      ].join('\n'),
    );
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    const dbItem = items.find((i) => i.title === 'Database');
    expect(dbItem).toBeDefined();
    expect(dbItem!.raw_text).toContain('row-level security');
    expect(dbItem!.platform).toBe('docs');
  });

  it('excludes the Align-managed marker block and the .align/ import line from what it imports', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      [
        '# My Project',
        '',
        '## Database',
        '',
        'We use Postgres with row-level security for every tenant-scoped table.',
        '',
        '<!-- align:start (managed by `align setup` - do not edit) -->',
        '## Align',
        'Some nudge text the CLI wrote, not the user.',
        '<!-- align:end -->',
        '',
        '@.align/decisions.md',
      ].join('\n'),
    );
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });
    const combined = items.map((i) => i.raw_text).join('\n');

    expect(combined).not.toContain('Some nudge text the CLI wrote');
    expect(combined).not.toContain('align:start');
    expect(combined).not.toContain('@.align/decisions.md');
  });

  it('a CLAUDE.md carrying ONLY the Align marker block must not round-trip into any item', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      [
        '<!-- align:start (managed by `align setup` - do not edit) -->',
        '## Align',
        'Some nudge text the CLI wrote, not the user.',
        '<!-- align:end -->',
        '',
      ].join('\n'),
    );
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items).toEqual([]);
  });

  it('splits multiple sections into separate items, each with its own title', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      [
        '# My Project',
        '',
        '## Database',
        '',
        'We use Postgres with row-level security for every tenant-scoped table.',
        '',
        '## Deployment',
        '',
        'We deploy via Helm to a single shared EKS cluster for prod and preview.',
      ].join('\n'),
    );
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items.map((i) => i.title).sort()).toEqual(['Database', 'Deployment']);
  });

  it('drops a trivial section (a bare heading with no real content) as noise', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      ['# My Project', '', '## TODO', '', 'tbd', '', '## Database', '', 'We use Postgres for the decision store.'].join('\n'),
    );
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items.map((i) => i.title)).toEqual(['Database']);
  });

  it('reads both CLAUDE.md and AGENTS.md when both exist', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    writeFileSync(join(repo, 'CLAUDE.md'), '# Proj\n\n## Database\n\nWe use Postgres for the decision store.');
    writeFileSync(join(repo, 'AGENTS.md'), '# Proj\n\n## Testing\n\nWe require a failing test before any fix lands.');
    mockGit(null);

    const items = await fetchDocsItems({ limit: 100, cwd: repo });

    expect(items.map((i) => i.title).sort()).toEqual(['Database', 'Testing']);
  });

  it('returns no agent-rules items, without throwing, when neither file exists', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mockGit(null);

    await expect(fetchDocsItems({ limit: 100, cwd: repo })).resolves.toEqual([]);
  });
});

describe('fetchDocsItems - limit and combination', () => {
  let repo: string;
  afterEach(() => {
    vi.clearAllMocks();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('caps the combined ADR + agent-rules item count at the given limit', async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-793-'));
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'adr', '1.md'), '# ADR One\n\nBecause reasons that are long enough here.');
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      '# Proj\n\n## Database\n\nWe use Postgres.\n\n## Testing\n\nWe require a failing test before any fix.',
    );
    mockGit(null);

    const items = await fetchDocsItems({ limit: 1, cwd: repo });

    expect(items).toHaveLength(1);
  });
});
