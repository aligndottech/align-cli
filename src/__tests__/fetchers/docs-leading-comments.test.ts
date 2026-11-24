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
  it('does not empty a text that is only a comment', () => {
    expect(stripLeadingHtmlComments('<!-- only -->\n')).toBe('<!-- only -->\n');
  });
});

describe('fetchDocsItems: an ADR with a comment header', () => {
  let repo = '';
  afterEach(() => { vi.clearAllMocks(); if (repo) rmSync(repo, { recursive: true, force: true }); });
  const put = (rel: string, text: string) => { mkdirSync(join(repo, dirname(rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
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
});
