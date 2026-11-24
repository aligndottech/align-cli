import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { fetchDocsItems } from '../../lib/fetchers/docs.js';
import { stripLeadingHtmlComments } from '../../lib/fetchers/strip-leading-comments.js';

/*
 * TEST LIST. vyasdx/adda-cli opens every ADR with two HTML comment lines, so the summary an agent saw first was the comment.
 * 1. An ADR whose text opens with comment lines imports with raw_text starting at its heading (header lifted from adda-cli).
 *    1b. a single multi-line comment, another ADR.
 * 2. Controls: a comment after the heading stays; an ADR with no comment is unchanged; text that is ONLY a comment is not emptied.
 */
const HEADER = '<!-- Developed by - Vedavyas Vayalpadu - vyas4c3@gmail.com -->\n<!-- Coded by - Claude Code -->\n\n';

describe('stripLeadingHtmlComments', () => {
  it('drops consecutive leading comment lines and the blank lines after them', () => {
    expect(stripLeadingHtmlComments(`${HEADER}# 0012 — Instruction files\n\nStatus: accepted\n`)).toBe('# 0012 — Instruction files\n\nStatus: accepted\n');
  });
  it('drops a multi-line comment', () => {
    expect(stripLeadingHtmlComments('<!--\n  owner: x\n  coder: y\n-->\n\n# 0002 — Templates\n\nBody.\n')).toBe('# 0002 — Templates\n\nBody.\n');
  });
  it('keeps a comment that comes after real text', () => {
    const t = '# 0003 — Eval\n\n<!-- keep -->\n\nBody.\n';
    expect(stripLeadingHtmlComments(t)).toBe(t);
  });
  it('leaves text with no leading comment alone', () => {
    expect(stripLeadingHtmlComments('# 0004 — A\n\nBody.\n')).toBe('# 0004 — A\n\nBody.\n');
  });
  it('stops at the first closing delimiter: text after it on the same line stays, and so does a later comment', () => {
    expect(stripLeadingHtmlComments('<!-- owner -->Keep this decision.\n\n<!-- later note -->\n\nRemaining text.\n'))
      .toBe('Keep this decision.\n\n<!-- later note -->\n\nRemaining text.\n');
  });
  it('a second comment right after the first, on the same line, also goes', () => {
    expect(stripLeadingHtmlComments('<!-- a --><!-- b -->\n# T\n\nBody.\n')).toBe('# T\n\nBody.\n');
  });
  it('does not empty a text that is only a comment', () => {
    expect(stripLeadingHtmlComments('<!-- only -->\n')).toBe('<!-- only -->\n');
  });
});

describe('fetchDocsItems: an ADR with a comment header', () => {
  let repo = '';
  afterEach(() => { vi.clearAllMocks(); if (repo) rmSync(repo, { recursive: true, force: true }); });
  const put = (rel: string, text: string) => { mkdirSync(join(repo, dirname(rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  const runWith = async (files: Record<string, string>) => {
    await run();
    for (const [rel, text] of Object.entries(files)) put(rel, text);
    return (await fetchDocsItems({ limit: 100, cwd: repo })).items;
  };
  const run = async () => {
    repo = mkdtempSync(join(tmpdir(), 'align-lead-'));
    vi.mocked(execa).mockImplementation(async (_c, args) => {
      const a = args as string[];
      if (a[0] === 'remote') return { stdout: 'https://github.com/org/repo.git' } as Awaited<ReturnType<typeof execa>>;
      if (a[0] === 'rev-parse') return { stdout: 'main' } as Awaited<ReturnType<typeof execa>>;
      throw new Error(`unexpected git ${a.join(' ')}`);
    });
    put('adda/DECISIONS/0012-a.md', `${HEADER}# 0012 — Instruction files are checked, not mapped\n\nStatus: accepted\n\n## Decision\nChecked.`);
    put('adda/DECISIONS/0013-b.md', '<!--\n  owner: x\n-->\n# 0013 — The map keeps keys\n\nStatus: accepted\n\n## Decision\nKept.');
    return (await fetchDocsItems({ limit: 100, cwd: repo })).items;
  };
  it('imports raw_text starting at the heading, for both header shapes', async () => {
    const items = await run();
    const by = (n: string) => items.find((i) => i.source_url.includes(n))!;
    expect(by('0012').raw_text.startsWith('# 0012 — Instruction files')).toBe(true);
    expect(by('0013').raw_text.startsWith('# 0013 — The map keeps keys')).toBe(true);
  });

  it('CRLF header: raw_text starts at the heading', async () => {
    const items = await runWith({ 'adda/DECISIONS/0020-a.md': `${HEADER.replace(/\n/g, '\r\n')}# 0020 — Crlf\r\n\r\nStatus: accepted\r\n\r\n## Decision\r\nDone.`, 'adda/DECISIONS/0021-b.md': '# 0021 — Other\n\nStatus: accepted\n\n## Decision\nDone.' });
    const a = items.find((i) => i.source_url.includes('0020'))!;
    expect(a.raw_text.startsWith('# 0020 — Crlf')).toBe(true);
    expect(a.title).toBe('0020 — Crlf');
  });
  it('BOM then header: raw_text starts at the heading', async () => {
    const items = await runWith({ 'adda/DECISIONS/0022-a.md': `\uFEFF${HEADER}# 0022 — Bom\n\nStatus: accepted\n\n## Decision\nDone.`, 'adda/DECISIONS/0023-b.md': '# 0023 — Other\n\nStatus: accepted\n\n## Decision\nDone.' });
    const a = items.find((i) => i.source_url.includes('0022'))!;
    expect(a.raw_text.startsWith('# 0022 — Bom')).toBe(true);
    expect(a.title).toBe('0022 — Bom');
  });
  it('a leading comment that holds "# Heading" text: the title is the real heading after it', async () => {
    const items = await runWith({ 'adda/DECISIONS/0024-a.md': '<!--\n# Template heading\nfill me\n-->\n# 0024 — Real title\n\nStatus: accepted\n\n## Decision\nDone.', 'adda/DECISIONS/0025-b.md': '# 0025 — Other\n\nStatus: accepted\n\n## Decision\nDone.' });
    const a = items.find((i) => i.source_url.includes('0024'))!;
    expect(a.title).toBe('0024 — Real title');
    expect(a.raw_text.startsWith('# 0024 — Real title')).toBe(true);
  });
  it('an agent-rules section that starts with a comment is unchanged (the comment can be the instruction)', async () => {
    const body = '<!-- Always ask before deleting files in this repo. -->\n- Use pnpm, never npm, for every install in this repo.\n- Keep functions short and well named everywhere.';
    const items = await runWith({ 'CLAUDE.md': `# Project\n\n## Rules\n${body}\n` });
    const sec = items.filter((i) => i.source_url.includes('CLAUDE.md'));
    expect(sec.length).toBeGreaterThan(0);
    expect(sec.some((i) => i.raw_text.includes('<!-- Always ask before deleting files'))).toBe(true);
  });
});
