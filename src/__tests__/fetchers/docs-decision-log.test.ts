import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { fetchDocsItems } from '../../lib/fetchers/docs.js';

const LEDGER = `# Defect ledger

id: D-001 · status: test · review_by: 2027-04-27 · modified: 2026-10-27
Retry the webhook three times before dead-lettering it.

id: D-002 | status: retired | modified: 2026-09-01
Poll the queue every five seconds instead of using push delivery.
`;

const NUMBERED = `# Decision log

## D17 - Use Postgres for the graph

We chose Postgres over a graph database because the team already runs it.

D181: Never store raw message text in the payload column
Decided: 2026-03-04
Raw text stays in the source system; we keep a pointer only.
`;

describe('fetchDocsItems - decision log files', () => {
  let repo: string;
  const write = (rel: string, content: string): void => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };
  const fresh = (): void => {
    repo = mkdtempSync(join(tmpdir(), 'align-decision-log-'));
    vi.mocked(execa).mockImplementation(async (_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'remote') return { stdout: 'https://github.com/acme/api' } as Awaited<ReturnType<typeof execa>>;
      if (a[0] === 'rev-parse') return { stdout: 'main' } as Awaited<ReturnType<typeof execa>>;
      throw new Error(`unexpected git invocation: ${a.join(' ')}`);
    });
  };
  const run = async () => (await fetchDocsItems({ limit: 100, cwd: repo })).items;
  afterEach(() => {
    vi.clearAllMocks();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('splits a ledger into one item per id line, with the id as the stable anchor', async () => {
    fresh();
    write('DEFECT_LEDGER.md', LEDGER);
    const items = await run();
    expect(items.map((i) => i.source_url)).toEqual([
      'https://github.com/acme/api/blob/main/DEFECT_LEDGER.md#d-001',
      'https://github.com/acme/api/blob/main/DEFECT_LEDGER.md#d-002',
    ]);
    expect(items[0].platform).toBe('docs');
    expect(items[0].raw_text).toContain('Retry the webhook three times');
    expect(items[0].raw_text).not.toContain('Poll the queue');
  });

  it('titles a ledger entry by its text, not its fields, and falls back to the id', async () => {
    fresh();
    write('DEFECT_LEDGER.md', `${LEDGER}\nid: D-003 · status: test\n`);
    const items = await run();
    expect(items[0].title).toBe('Retry the webhook three times before dead-lettering it.');
    expect(items[1].title).toBe('Poll the queue every five seconds instead of using push delivery.');
    expect(items[2].title).toBe('D-003');
  });

  it('dates an entry from modified:, and leaves it unset when no date field parses', async () => {
    fresh();
    write('DEFECT_LEDGER.md', `${LEDGER}\nid: D-004 · modified: soon\nSomething was decided here with no usable date.\n`);
    const items = await run();
    expect(items[0].created_at).toBe('2026-10-27T00:00:00.000Z');
    expect(items[2]).toBeDefined();
    expect(items[2].created_at).toBeUndefined();
  });

  it('splits a numbered log on headings and on D181: lines, dating from decided:', async () => {
    fresh();
    write('DECISIONS.md', NUMBERED);
    const items = await run();
    expect(items.map((i) => i.source_url)).toEqual([
      'https://github.com/acme/api/blob/main/DECISIONS.md#d17',
      'https://github.com/acme/api/blob/main/DECISIONS.md#d181',
    ]);
    expect(items[0].title).toBe('D17 - Use Postgres for the graph');
    expect(items[0].raw_text).toContain('team already runs it');
    expect(items[1].title).toBe('D181: Never store raw message text in the payload column');
    expect(items[1].created_at).toBe('2026-03-04T00:00:00.000Z');
  });

  it('falls back to the heading slug when an entry has no id', async () => {
    fresh();
    write('docs/decisions.md', '# Decisions\n\n## Use pnpm everywhere\n\nWe use pnpm in every package so lockfiles agree.\n');
    const items = await run();
    expect(items.map((i) => i.source_url)).toEqual(['https://github.com/acme/api/blob/main/docs/decisions.md#use-pnpm-everywhere']);
  });

  it('finds the listed names at the root and in docs/', async () => {
    fresh();
    const body = (id: string) => `${id}: Keep this decision in the log file\n`;
    for (const [i, f] of ['DECISION_LOG.md', 'DECISION-LOG.md', 'docs/DECISIONS.md', 'docs/team-LEDGER.md'].entries()) write(f, body(`D${i + 1}`));
    const urls = (await run()).map((i) => i.source_url).sort();
    expect(urls).toHaveLength(4);
    expect(urls.some((u) => u.includes('/docs/team-LEDGER.md#d4'))).toBe(true);
  });

  it('never reads anything under .align/', async () => {
    fresh();
    write('DECISIONS.md', 'D1: A real decision the user wrote by hand\n');
    write('.align/decisions.md', 'D2: Align wrote this itself and must not read it back\n');
    write('.align/DECISIONS.md', 'D3: Align wrote this itself and must not read it back\n');
    const urls = (await run()).map((i) => i.source_url);
    expect(urls).toEqual(['https://github.com/acme/api/blob/main/DECISIONS.md#d1']);
  });

  it('imports nothing from a decision log file with no recognisable entries', async () => {
    fresh();
    write('DECISIONS.md', '# Decisions\n\nWe will write these down one day, when we have time to do it properly.\n');
    expect(await run()).toEqual([]);
  });

  it('imports a retired entry and keeps its status text in raw_text', async () => {
    fresh();
    write('DEFECT_LEDGER.md', LEDGER);
    const retired = (await run()).find((i) => i.source_url.endsWith('#d-002'));
    expect(retired).toBeDefined();
    expect(retired!.raw_text).toContain('status: retired');
  });

  it('keeps a fenced example containing an id line inside its entry', async () => {
    fresh();
    write('DECISIONS.md', 'D1: Log entries use this format\n\n```\nD999: example only, not a decision\n## Not a heading\n```\n\nD2: Entries are append-only in the file\n');
    const items = await run();
    expect(items.map((i) => i.source_url.split('#')[1])).toEqual(['d1', 'd2']);
    expect(items[0].raw_text).toContain('D999: example only');
  });

  it('removes key: value fields from a heading title and keeps them in raw_text', async () => {
    fresh();
    write('DECISIONS.md', '## D17 - Use Postgres | status: superseded\n\nThe graph lives in Postgres for now.\n');
    const [item] = await run();
    expect(item.title).toBe('D17 - Use Postgres');
    expect(item.raw_text).toContain('status: superseded');
  });

  it('keeps a heading segment after | that is not a field', async () => {
    fresh();
    write('DECISIONS.md', '## D18 - Support Linux | macOS | status: accepted\n\nBoth platforms ship.\n');
    const [item] = await run();
    expect(item.title).toBe('D18 - Support Linux | macOS');
  });

  it('keeps a short entry that has a recognised id', async () => {
    fresh();
    write('DECISIONS.md', 'D1: Use PostgreSQL\n');
    const items = await run();
    expect(items.map((i) => i.title)).toEqual(['D1: Use PostgreSQL']);
  });
});
