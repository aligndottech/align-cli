import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { fetchDocsItems } from '../../lib/fetchers/docs.js';

/** A bulleted list of standalone rules in AGENTS.md is one decision per rule; prose and example lists stay whole. */
let repo: string;
afterEach(() => {
  vi.clearAllMocks();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

async function importAgents(content: string) {
  repo = mkdtempSync(join(tmpdir(), 'align-rulesplit-'));
  vi.mocked(execa).mockImplementation(async (_cmd, args) => {
    const a = args as string[];
    if (a[0] === 'remote') return { stdout: 'https://github.com/o/r.git' } as Awaited<ReturnType<typeof execa>>;
    return { stdout: 'main' } as Awaited<ReturnType<typeof execa>>;
  });
  writeFileSync(join(repo, 'AGENTS.md'), content);
  return (await fetchDocsItems({ limit: 100, cwd: repo })).items;
}

const PRINCIPLES = `## Core principles

- Never commit a real secret, token or key.
- Never force-push to main or run \`git reset --hard\` without asking first.
- Always run the test suite before opening a pull request.
- Do not edit generated files by hand.
  - Regenerate them with scripts/gen.sh instead.
- Prefer small, reviewable commits.
`;

describe('AGENTS.md rule lists', () => {
  it('splits a list of standalone rules into one decision per rule, keeping the section as a prefix', async () => {
    const items = await importAgents(PRINCIPLES);
    expect(items).toHaveLength(5);
    // The title is the rule as written, so the committed-file privacy check (titleIsInCommittedFile) still finds it.
    expect(items[0]!.title).toBe('Never commit a real secret, token or key.');
    expect(items[1]!.title).toContain('Never force-push to main');
    expect(items[1]!.raw_text).toContain('Core principles');
    expect(items[1]!.raw_text).not.toContain('Never commit a real secret');
  });

  it('keeps a nested sub-bullet with its parent rule', async () => {
    const items = await importAgents(PRINCIPLES);
    const gen = items.find((i) => i.title.includes('generated files'))!;
    expect(gen.raw_text).toContain('Regenerate them with scripts/gen.sh');
    expect(items.some((i) => i.title.includes('Regenerate them'))).toBe(false);
  });

  it('gives each rule its own stable source_url, identical on a re-import', async () => {
    const first = await importAgents(PRINCIPLES);
    const urls = first.map((i) => i.source_url);
    expect(new Set(urls).size).toBe(5);
    const again = await importAgents(PRINCIPLES);
    expect(again.map((i) => i.source_url)).toEqual(urls);
  });

  it('gives two identical rules in one section different urls', async () => {
    const items = await importAgents('## Rules\n\n- Never push to main.\n- Never push to main.\n- Always run the tests.\n');
    expect(new Set(items.map((i) => i.source_url)).size).toBe(3);
  });

  it('does not split a prose paragraph', async () => {
    const prose = '## Testing\n\nTests live under tests/. Run them with the script in scripts/ and read the output before pushing, because the harness is noisy.\n';
    const items = await importAgents(prose);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Testing');
  });

  it('does not split a list of links or examples', async () => {
    const items = await importAgents('## Examples\n\n- [FLOWS.md](FLOWS.md)\n- [EXAMPLES.md](EXAMPLES.md)\n- `scripts/gen.sh`\n- The installer in install.sh\n');
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Examples');
  });

  it('does not split a list that sits inside prose', async () => {
    const items = await importAgents('## Release\n\nThe release has three parts and each one matters a great deal to the maintainer.\n\n- Never skip one\n- Always tag\n- Use the script\n\nThen wait for the build to finish and read its output before announcing anything at all.\n');
    expect(items).toHaveLength(1);
  });

  it('does not split a list of fewer than three items', async () => {
    const items = await importAgents('## Safety\n\n- Never commit a secret to the repository.\n- Always ask before deleting files.\n');
    expect(items).toHaveLength(1);
  });

  it('keeps 30 rule rows plus one overflow row for a 40-rule section', async () => {
    const list = Array.from({ length: 40 }, (_, i) => `- Never touch file number ${i} directly.`).join('\n');
    const items = await importAgents(`## Rules\n\n${list}\n`);
    expect(items).toHaveLength(31);
  });

  it('puts the whole rule in the title even when it is long, so DECISIONS.md carries it', async () => {
    const long = 'Never force-push to main or run git reset --hard without asking first, because other people and other agents build on that branch and a rewritten history strands their work';
    const items = await importAgents(`## Rules\n\n- ${long}.\n- Always run the tests.\n- Ask before deleting files.\n`);
    expect(items[0]!.title).toBe(`${long}.`);
  });

  it('never splits a numbered list, even of rules', async () => {
    expect(await importAgents('## Install\n\n1. Never run this as root.\n2. Always use a clean machine.\n3. Do not skip the checksum.\n')).toHaveLength(1);
    expect(await importAgents('## Install\n\n1) Clone the repo.\n2) Run the installer.\n3) Restart your shell.\n')).toHaveLength(1);
  });

  it('never splits a Label: `command` list', async () => {
    const items = await importAgents('## Commands\n\n- Build: `pnpm build`\n- Test: `pnpm test`\n- Lint: `pnpm lint`\n');
    expect(items).toHaveLength(1);
  });

  it('never splits an option list', async () => {
    const items = await importAgents('## Flags\n\n- Use `--fast` to skip the slow checks.\n- Use `--json` to print one object.\n- Use `--quiet` to hide progress.\n');
    expect(items).toHaveLength(1);
  });

  it('never splits a changelog-style list', async () => {
    const items = await importAgents('## Changes\n\n- Add the export command\n- Add a retry to the fetcher\n- Update dependencies\n');
    expect(items).toHaveLength(1);
  });

  it('splits at exactly 60% modal items (3 of 5) and keeps the section whole just under it (4 of 7)', async () => {
    const m = (n: number) => `- Never touch file ${n}.`;
    const p = (n: number) => `- Notes on file ${n}.`;
    expect(await importAgents(`## R\n\n${[m(1), m(2), m(3), p(4), p(5)].join('\n')}\n`)).toHaveLength(5);
    expect(await importAgents(`## R\n\n${[m(1), m(2), m(3), m(4), p(5), p(6), p(7)].join('\n')}\n`)).toHaveLength(1);
  });

  it('splits at 70% modal (7 of 10) and keeps 50% whole (2 of 4)', async () => {
    const m = (n: number) => `- Never touch file ${n}.`;
    const p = (n: number) => `- Notes on file ${n}.`;
    const seven = Array.from({ length: 10 }, (_, i) => (i < 7 ? m(i) : p(i))).join('\n');
    expect(await importAgents(`## R\n\n${seven}\n`)).toHaveLength(10);
    expect(await importAgents(`## R\n\n${[m(1), m(2), p(3), p(4)].join('\n')}\n`)).toHaveLength(1);
  });

  it('splits at exactly 3 rules and keeps 2 whole', async () => {
    expect(await importAgents('## R\n\n- Never commit a secret.\n- Always run the tests.\n- Ask before deleting, and never guess.\n')).toHaveLength(3);
    expect(await importAgents('## R\n\n- Never commit a secret.\n- Always run the tests.\n')).toHaveLength(1);
  });

  it('allows an intro of exactly 300 characters and refuses 301', async () => {
    const list = '- Never commit a secret.\n- Always run the tests.\n- Do not force push.\n';
    expect(await importAgents(`## R\n\n${'x'.repeat(300)}\n\n${list}`)).toHaveLength(3);
    expect(await importAgents(`## R\n\n${'x'.repeat(301)}\n\n${list}`)).toHaveLength(1);
  });

  it('splits a CRLF file the same as an LF one', async () => {
    const items = await importAgents(PRINCIPLES.replace(/\n/g, '\r\n'));
    expect(items).toHaveLength(5);
    expect(items[0]!.title).toBe('Never commit a real secret, token or key.');
  });

  it('reports the rules past the cap, with the section', async () => {
    repo = '';
    const list = Array.from({ length: 33 }, (_, i) => `- Never touch file number ${i} directly.`).join('\n');
    const r = mkdtempSync(join(tmpdir(), 'align-rulesplit-'));
    repo = r;
    vi.mocked(execa).mockResolvedValue({ stdout: 'main' } as Awaited<ReturnType<typeof execa>>);
    writeFileSync(join(r, 'AGENTS.md'), `## Big rules\n\n${list}\n`);
    const { report } = await fetchDocsItems({ limit: 100, cwd: r });
    expect(report.skips).toContainEqual({ count: 3, detail: 'rules past the 30 kept from the "Big rules" section' });
  });

  it('gives two non-Latin rules distinct urls', async () => {
    const items = await importAgents('## R\n\n- Never 提交 密钥。\n- Always 运行 测试。\n- Do not 强制 推送。\n');
    expect(new Set(items.map((i) => i.source_url)).size).toBe(3);
  });

  it('keeps a rule url when a rule is inserted or the rules are reordered', async () => {
    const a = 'Never commit a real secret.';
    const b = 'Always run the tests first.';
    const c = 'Do not force push to main.';
    const base = await importAgents(`## R\n\n- ${a}\n- ${b}\n- ${c}\n`);
    const urlOf = (items: typeof base, text: string) => items.find((i) => i.title === text)!.source_url;
    const reordered = await importAgents(`## R\n\n- ${c}\n- Never ever.\n- ${a}\n- ${b}\n`);
    for (const t of [a, b, c]) expect(urlOf(reordered, t)).toBe(urlOf(base, t));
  });

  it('keeps non-Latin rule urls when the rules are reordered', async () => {
    const x = 'Never 提交 密钥。';
    const y = 'Always 运行 测试。';
    const z = 'Do not 强制 推送。';
    const one = await importAgents(`## R\n\n- ${x}\n- ${y}\n- ${z}\n`);
    const two = await importAgents(`## R\n\n- ${z}\n- ${x}\n- ${y}\n`);
    for (const t of [x, y, z]) expect(two.find((i) => i.title === t)!.source_url).toBe(one.find((i) => i.title === t)!.source_url);
  });

  it('keeps rules that share a 60-character prefix apart, by hash and not by position', async () => {
    const prefix = 'Never commit a secret to the repository under any condition ';
    const x = `${prefix}in a branch.`;
    const y = `${prefix}in a tag.`;
    const one = await importAgents(`## R\n\n- ${x}\n- ${y}\n- Always run the tests.\n`);
    const two = await importAgents(`## R\n\n- ${y}\n- Always run the tests.\n- ${x}\n`);
    expect(new Set(one.map((i) => i.source_url)).size).toBe(3);
    expect(two.find((i) => i.title === x)!.source_url).toBe(one.find((i) => i.title === x)!.source_url);
    expect(two.find((i) => i.title === y)!.source_url).toBe(one.find((i) => i.title === y)!.source_url);
  });

  it('keeps rules 31 and up as one trailing row, so they stay in the graph', async () => {
    const list = Array.from({ length: 35 }, (_, i) => `- Never touch file number ${i} directly.`).join('\n');
    const items = await importAgents(`## Big rules\n\n${list}\n`);
    expect(items).toHaveLength(31);
    const last = items[30]!;
    expect(last.title).toBe('Further rules from the Big rules section');
    for (let i = 30; i < 35; i++) expect(last.raw_text).toContain(`Never touch file number ${i} directly.`);
    expect(last.raw_text).not.toContain('file number 29 ');
  });

  it('never changes an existing rule url when a sibling sharing its prefix is added', async () => {
    const prefix = 'Never commit a secret to the repository under any condition ';
    const x = `${prefix}in a branch.`;
    const before = await importAgents(`## R\n\n- ${x}\n- Always run the tests.\n- Do not force push.\n`);
    const after = await importAgents(`## R\n\n- ${x}\n- ${prefix}in a tag.\n- Always run the tests.\n- Do not force push.\n`);
    expect(after.find((i) => i.title === x)!.source_url).toBe(before.find((i) => i.title === x)!.source_url);
  });

  it('does not read a horizontal rule as a rule item', async () => {
    expect(await importAgents('## R\n\n- Never a.\n- Always b.\n* * *\n- Do not c.\n')).toHaveLength(1);
    const items = await importAgents('## R\n\n- Never a.\n- Always b.\n- Do not c.\n\n- - -\n');
    expect(items).toHaveLength(1);
  });
});
