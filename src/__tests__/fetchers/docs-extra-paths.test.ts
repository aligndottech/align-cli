/**
 * A folder the user names (`--docs-path spec/gotchas`) is read as docs even though its name is no convention and its files
 * are not numbered or dated. A user's lessons lived in spec/gotchas/*.md and were never imported.
 * Test List:
 * 1. without the option, unnumbered files in spec/gotchas are not imported (the miss)
 * 2. with it, each file is one item: title from its first heading, source url naming the file
 * 3. two folders, both read; a folder already on the convention list is not read twice
 * 4. a folder that does not exist, one outside the repo, and a path that is a file are refused loudly, not skipped
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { fetchDocsItems } from '../../lib/fetchers/docs.js';

describe('fetchDocsItems - user-named docs folders', () => {
  let repo: string;
  let topLevel: string | null = null;
  const write = (rel: string, content: string): void => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };
  const fresh = (): void => {
    repo = mkdtempSync(join(tmpdir(), 'align-extra-docs-'));
    vi.mocked(execa).mockImplementation(async (_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'remote') return { stdout: 'https://github.com/acme/api' } as Awaited<ReturnType<typeof execa>>;
      if (a[0] === 'rev-parse' && a[1] === '--show-toplevel') { if (topLevel) return { stdout: topLevel } as Awaited<ReturnType<typeof execa>>; throw new Error('not a repo'); }
      if (a[0] === 'rev-parse') return { stdout: 'main' } as Awaited<ReturnType<typeof execa>>;
      throw new Error(`unexpected git invocation: ${a.join(' ')}`);
    });
    write('spec/gotchas/retry-storms.md', '# Retries amplify an outage\n\nNever retry a 503 without a jittered backoff, or one slow dependency takes the whole queue down.\n');
    write('spec/gotchas/utc-only.md', '# Store UTC, convert at the edge\n\nA local-time column cost us a day of wrong invoices in March.\n');
    write('spec/other/lock-order.md', '# Take locks in table order\n\nTwo jobs taking the same pair of locks in opposite order deadlocked the nightly run.\n');
  };
  afterEach(() => {
    vi.clearAllMocks();
    topLevel = null;
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('does not import an unnumbered folder it was not told about', async () => {
    fresh();
    expect((await fetchDocsItems({ limit: 100, cwd: repo })).items).toEqual([]);
  });

  it('reads each file in a named folder as one item, titled by its first heading', async () => {
    fresh();
    const { items, report } = await fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec/gotchas'] });
    expect(items.map((i) => i.title)).toEqual(['Retries amplify an outage', 'Store UTC, convert at the edge']);
    expect(items.map((i) => i.source_url)).toEqual([
      'https://github.com/acme/api/blob/main/spec/gotchas/retry-storms.md',
      'https://github.com/acme/api/blob/main/spec/gotchas/utc-only.md',
    ]);
    expect(items.every((i) => i.platform === 'docs')).toBe(true);
    expect(report.scopeNote).toMatch(/spec\/gotchas/);
  });

  it('reads several folders, and a folder already on the convention list once', async () => {
    fresh();
    write('docs/adr/0001-use-postgres.md', '# Use Postgres\n\nStatus: accepted\n\nDecision: Postgres.\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec/gotchas/', './spec/other', 'docs/adr'] });
    expect(items.map((i) => i.title).sort()).toEqual([
      'Retries amplify an outage', 'Store UTC, convert at the edge', 'Take locks in table order', 'Use Postgres',
    ]);
  });

  it('refuses a folder that does not exist, instead of skipping it', async () => {
    fresh();
    await expect(fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec/gotchaz'] })).rejects.toThrow(/spec\/gotchaz.*not a folder/s);
  });

  it('refuses a path outside the repo, absolute or through .., or through a symlink', async () => {
    fresh();
    const outside = mkdtempSync(join(tmpdir(), 'align-extra-outside-'));
    writeFileSync(join(outside, 'secret.md'), '# Not yours\n\nOutside the repo.\n');
    symlinkSync(outside, join(repo, 'linked'));
    for (const p of ['../elsewhere', outside, 'linked']) {
      await expect(fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: [p] })).rejects.toThrow(/inside this repo/);
    }
    rmSync(outside, { recursive: true, force: true });
  });

  it('keeps the folders you named ahead of ADRs when the limit cuts', async () => {
    fresh();
    write('docs/adr/0001-a.md', '# A\n\nStatus: accepted\n\nDecision: a.\n');
    write('docs/adr/0002-b.md', '# B\n\nStatus: accepted\n\nDecision: b.\n');
    const { items, report } = await fetchDocsItems({ limit: 2, cwd: repo, extraDocsPaths: ['spec/gotchas'] });
    expect(items.map((i) => i.title)).toEqual(['Retries amplify an outage', 'Store UTC, convert at the edge']);
    expect(report.scopeNote).toMatch(/folders you named: spec\/gotchas/);
  });

  it('says so when the limit leaves none of a named folder', async () => {
    fresh();
    write('docs/adr/0001-a.md', '# A\n\nStatus: accepted\n\nDecision: a.\n');
    mkdirSync(join(repo, 'spec/empty'), { recursive: true });
    const { report } = await fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec/empty'] });
    expect(report.scopeNote).toMatch(/no markdown files kept.*spec\/empty/);
  });

  it('accepts a folder whose name starts with two dots', async () => {
    fresh();
    write('..notes/one.md', '# One lesson\n\nA lesson written down in a folder with an odd name.\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['..notes'] });
    expect(items.map((i) => i.title)).toEqual(['One lesson']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a folder it cannot read instead of skipping it', async () => {
    fresh();
    chmodSync(join(repo, 'spec/gotchas'), 0o000);
    try {
      await expect(fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec/gotchas'] })).rejects.toThrow(/cannot be read/);
    } finally {
      chmodSync(join(repo, 'spec/gotchas'), 0o755);
    }
  });

  it('does not follow a symlinked file inside a named folder out of the repo', async () => {
    fresh();
    const outside = mkdtempSync(join(tmpdir(), 'align-extra-outside-'));
    writeFileSync(join(outside, 'secret.md'), '# Not yours\n\nOutside the repo.\n');
    symlinkSync(join(outside, 'secret.md'), join(repo, 'spec/gotchas/linked.md'));
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec/gotchas'] });
    expect(items.map((i) => i.title)).not.toContain('Not yours');
    rmSync(outside, { recursive: true, force: true });
  });

  it('resolves a relative name against where you run it, and accepts a folder elsewhere in the repo (CodeRabbit)', async () => {
    fresh();
    topLevel = repo;
    write('docs/notes/lesson.md', '# A lesson from docs\n\nWritten in the top-level docs folder, not under spec.\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: join(repo, 'spec'), extraDocsPaths: ['../docs/notes'] });
    expect(items.map((i) => i.title)).toEqual(['A lesson from docs']);
    // The url names the file from the repo root, not from where the command ran.
    expect(items[0]!.source_url).toBe('https://github.com/acme/api/blob/main/docs/notes/lesson.md');
  });

  it('still refuses a path above the repo top-level when run from a subfolder', async () => {
    fresh();
    topLevel = repo;
    await expect(fetchDocsItems({ limit: 100, cwd: join(repo, 'spec'), extraDocsPaths: ['../../elsewhere'] })).rejects.toThrow(/inside this repo/);
    await expect(fetchDocsItems({ limit: 100, cwd: join(repo, 'spec'), extraDocsPaths: [tmpdir()] })).rejects.toThrow(/inside this repo/);
  });

  it('keeps an empty parent in the unused report when only its child contributed (CodeRabbit)', async () => {
    fresh();
    const { report } = await fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec', 'spec/gotchas'] });
    expect(report.scopeNote).toMatch(/folders you named: spec\/gotchas/);
    expect(report.scopeNote).toMatch(/no markdown files kept[^;]*\bspec\b(?!\/)/);
  });

  it('refuses a path that is a file', async () => {
    fresh();
    await expect(fetchDocsItems({ limit: 100, cwd: repo, extraDocsPaths: ['spec/gotchas/utc-only.md'] })).rejects.toThrow(/not a folder/);
  });
});
