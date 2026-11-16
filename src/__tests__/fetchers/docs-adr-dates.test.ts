/**
 * ALI-2114: an ADR carries a decision date. Test List (two examples per rule):
 *  D1  a `Date:` line in the body (Nygard; `* Date:` and `**Date:**` too)      -> created_at
 *  D2  YAML front matter `date:` (MADR; bare and quoted)                        -> created_at
 *  D3  neither: the date of the file's FIRST commit (real git, never mocked)    -> created_at
 *  D4  an unparseable date drops the field, never guesses                       (no git: no field)
 *  D5  no git repo at all: the import still succeeds, with no date
 *  D6  AsciiDoc: `:revdate:` / `Date:` line, else the git date
 *  D7  non-ADR kinds (README/CONTRIBUTING rules, agent rules) are unchanged
 *  D8  the stored decided_at is the declared date
 *  D9  the edit check no longer says "no decision date" for a dated ADR
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

vi.mock('../../lib/similarity/embedding-matrix.js', async () =>
  (await import('../helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));
vi.setConfig({ testTimeout: 30_000 });

import { chmodSync } from 'node:fs';
import { firstCommitDate, mapLimit } from '../../lib/fetchers/adr-date.js';
import { fetchDocsItems } from '../../lib/fetchers/docs.js';
import { createLocalGatewayClient } from '../../lib/local-gateway-client.js';
import { createLocalDb } from '../../lib/local-db.js';
import { buildRelatedOutput } from '../../commands/check.js';

let repo: string;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'align-2114-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(repo, { recursive: true, force: true }); });

const BODY = 'We need a relational store with strong consistency across services.';
function adr(name: string, text: string, dir = 'docs/adr'): void {
  mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, dir, name), text);
}
async function dateOf(name: string): Promise<string | undefined> {
  const { items } = await fetchDocsItems({ limit: 50, cwd: repo });
  const hit = items.find((i) => i.source_url.endsWith(name)) as { created_at?: string } | undefined;
  expect(hit, `item ${name} was not imported`).toBeDefined();
  return hit?.created_at;
}
async function git(args: string[], date?: string): Promise<void> {
  await execa('git', args, {
    cwd: repo,
    env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
}

describe('D1 a Date line in the body', () => {
  it('reads the Nygard line', async () => {
    adr('0001-a.md', `# 1. Use Postgres\n\nDate: 2024-03-01\n\nStatus: Accepted\n\n${BODY}`);
    expect(await dateOf('0001-a.md')).toBe('2024-03-01');
  });
  it('tolerates `* Date:` and `**Date:**`', async () => {
    adr('0002-b.md', `# 2. B\n\n* Date: 2023-11-05\n\n${BODY}`);
    adr('0003-c.md', `# 3. C\n\n**Date:** 2022-01-02\n\n${BODY}`);
    expect(await dateOf('0002-b.md')).toBe('2023-11-05');
    expect(await dateOf('0003-c.md')).toBe('2022-01-02');
  });
  it('wins over front matter when both are present', async () => {
    adr('0004-d.md', `---\ndate: 2020-01-01\n---\n# 4. D\n\nDate: 2024-04-04\n\n${BODY}`);
    expect(await dateOf('0004-d.md')).toBe('2024-04-04');
  });
});

describe('D2 YAML front matter', () => {
  it('reads a bare date', async () => {
    adr('0005-e.md', `---\nstatus: accepted\ndate: 2021-06-07\n---\n# E\n\n${BODY}`);
    expect(await dateOf('0005-e.md')).toBe('2021-06-07');
  });
  it('reads a quoted date', async () => {
    adr('0006-f.md', `---\ndate: "2021-06-08"\n---\n# F\n\n${BODY}`);
    expect(await dateOf('0006-f.md')).toBe('2021-06-08');
  });
});

describe('D3 first commit date (real git)', () => {
  it('uses the date the file was first added, not the later edit', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0007-g.md', `# G\n\n${BODY}`);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'add'], '2022-05-06T10:00:00+00:00');
    adr('0007-g.md', `# G\n\n${BODY}\n\nEdited later.`);
    await git(['commit', '-q', '-am', 'edit'], '2025-01-01T10:00:00+00:00');
    expect(await dateOf('0007-g.md')).toBe('2022-05-06T10:00:00.000Z');
  });
  it('dates each file by its own first commit', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0008-h.md', '# H\n\nQueues: SQS beats Redis because Redis lost jobs during failover last spring.');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'h'], '2021-02-03T00:00:00+00:00');
    adr('0009-i.md', '# I\n\nAuth: sessions live in signed cookies since the gateway must stay stateless.');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'i'], '2023-09-10T00:00:00+00:00');
    expect(await dateOf('0008-h.md')).toBe('2021-02-03T00:00:00.000Z');
    expect(await dateOf('0009-i.md')).toBe('2023-09-10T00:00:00.000Z');
  });
  it('gives an untracked file no date, rather than failing', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0010-j.md', `# J\n\n${BODY}`);
    expect(await dateOf('0010-j.md')).toBeUndefined();
  });
});

describe('D4 unparseable dates', () => {
  it('drops the field for a Date line that is not a date', async () => {
    adr('0011-k.md', `# K\n\nDate: someday soon\n\n${BODY}`);
    expect(await dateOf('0011-k.md')).toBeUndefined();
  });
  it('drops the field for a front matter date that is not a date', async () => {
    adr('0012-l.md', `---\ndate: 2024-13-45\n---\n# L\n\n${BODY}`);
    expect(await dateOf('0012-l.md')).toBeUndefined();
  });
});

describe('D4c a day that does not exist', () => {
  it('drops 2024-02-30 instead of rolling it to March', async () => {
    adr('0020-t.md', `# T\n\nDate: 2024-02-30\n\n${BODY}`);
    expect(await dateOf('0020-t.md')).toBeUndefined();
  });
  it('drops 2023-02-29', async () => {
    adr('0021-u.md', `# U\n\nDate: 2023-02-29\n\n${BODY}`);
    expect(await dateOf('0021-u.md')).toBeUndefined();
  });
});

describe('D3b a moved ADR keeps its original date', () => {
  it('follows a rename between ADR directories', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0022-v.md', '# V\n\nCaching: we cache at the edge because origin latency dominated p95 in March.', 'doc/adr');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'v'], '2020-03-04T00:00:00+00:00');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    await git(['mv', 'doc/adr', 'docs/adr']);
    await git(['commit', '-q', '-m', 'move'], '2024-04-04T00:00:00+00:00');
    expect(await dateOf('0022-v.md')).toBe('2020-03-04T00:00:00.000Z');
  });
});

describe('D4d prose that merely starts with the word date is not a declaration', () => {
  it('"Dates are stored in UTC." leaves the git date in force', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0023-w.md', `# W\n\nDates are stored in UTC.\n\n${BODY}`);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'w'], '2021-07-08T00:00:00+00:00');
    expect(await dateOf('0023-w.md')).toBe('2021-07-08T00:00:00.000Z');
  });
  it('"- date range filter" leaves the git date in force', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0024-x.md', `# X\n\n- date range filter\n- Datetime handling\n\n${BODY}`);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'x'], '2021-08-09T00:00:00+00:00');
    expect(await dateOf('0024-x.md')).toBe('2021-08-09T00:00:00.000Z');
  });
  it('still reads `**Date**: 2022-03-04`', async () => {
    adr('0025-y.md', `# Y\n\n**Date**: 2022-03-04\n\n${BODY}`);
    expect(await dateOf('0025-y.md')).toBe('2022-03-04');
  });
});

describe('D3c template siblings keep their own dates', () => {
  it('two ADRs differing only in title and decision line', async () => {
    await git(['init', '-q', '-b', 'main']);
    const tpl = (t: string, d: string) => `# ${t}\n\n## Status\n\nAccepted\n\n## Context\n\nWe have a problem that needs a decision from the team.\n\n## Decision\n\n${d}\n\n## Consequences\n\nSome things get easier and some get harder over time.\n`;
    adr('0026-aa.md', tpl('Use SQS', 'We use SQS.'));
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'aa'], '2020-01-02T00:00:00+00:00');
    adr('0027-bb.md', tpl('Use Redis', 'We use Redis.'));
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'bb'], '2023-05-06T00:00:00+00:00');
    expect(await dateOf('0026-aa.md')).toBe('2020-01-02T00:00:00.000Z');
    expect(await dateOf('0027-bb.md')).toBe('2023-05-06T00:00:00.000Z');
  });
});

describe('D4b a bad declared date is not replaced by the git date', () => {
  it('stays undated in a repo with history', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0019-s.md', `# S\n\nDate: TBD\n\n${BODY}`);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 's'], '2022-02-02T00:00:00+00:00');
    expect(await dateOf('0019-s.md')).toBeUndefined();
  });
});

describe('D5 no git', () => {
  it('imports an undated ADR in a directory that is not a repo', async () => {
    adr('0013-m.md', `# M\n\n${BODY}`);
    expect(await dateOf('0013-m.md')).toBeUndefined();
  });
  it('still reads a declared date in a directory that is not a repo', async () => {
    adr('0014-n.md', `# N\n\nDate: 2019-07-08\n\n${BODY}`);
    expect(await dateOf('0014-n.md')).toBe('2019-07-08');
  });
});

describe('D6 AsciiDoc', () => {
  it('reads :revdate:', async () => {
    adr('0015-o.adoc', `= O\n:revdate: 2024-02-03\n\n${BODY}`);
    expect(await dateOf('0015-o.adoc')).toBe('2024-02-03');
  });
  it('reads a Date: line, and falls back to git otherwise', async () => {
    adr('0016-p.adoc', `= P\n\nDate: 2020-10-11\n\n${BODY}`);
    adr('0017-q.adoc', `= Q\n\n${BODY}`);
    await git(['init', '-q', '-b', 'main']);
    await git(['add', '0017-q.adoc'].map((f) => (f.endsWith('adoc') ? `docs/adr/${f}` : f)));
    await git(['commit', '-q', '-m', 'q'], '2018-03-04T00:00:00+00:00');
    expect(await dateOf('0016-p.adoc')).toBe('2020-10-11');
    expect(await dateOf('0017-q.adoc')).toBe('2018-03-04T00:00:00.000Z');
  });
});

describe('D7 non-ADR kinds are unchanged', () => {
  it('gives README and CLAUDE.md sections no created_at, even with a Date line and git history', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), `# T\n\n## Rules\n\nDate: 2024-01-01\nAlways run the tests before pushing code.\n`);
    writeFileSync(join(repo, 'README.md'), `# R\n\n## Conventions\n\nAlways use pnpm, never npm, in this repository.\n`);
    await git(['init', '-q', '-b', 'main']);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'x'], '2020-01-01T00:00:00+00:00');
    const { items } = await fetchDocsItems({ limit: 50, cwd: repo });
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const i of items) expect(i).not.toHaveProperty('created_at');
  });
});

describe('D8 / D9 stored decided_at and the edit check', () => {
  it('stores the declared date as decided_at, and the check stops saying "no decision date"', async () => {
    adr('0018-r.md', `# 18. Use Postgres\n\nDate: 2025-09-01\n\n${BODY}`);
    const { items } = await fetchDocsItems({ limit: 50, cwd: repo });
    const dbPath = join(repo, 'graph.db');
    const client = createLocalGatewayClient(dbPath);
    const { snapshots } = await client.ingestBatch(items);
    client.close?.();
    const db = createLocalDb(dbPath);
    const row = db.getDecisionById(snapshots[0].id);
    db.close();
    expect(row?.decidedAt).toBe('2025-09-01T00:00:00.000Z');

    const now = Date.UTC(2026, 10, 14);
    const out = buildRelatedOutput(
      [{ id: 'x', title: 'Use Postgres', decided_at: row?.decidedAt ?? undefined }],
      { pre: true, format: 'claude', blockOnCritical: false, now },
    ) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain('Use Postgres');
    expect(out.hookSpecificOutput.additionalContext).not.toContain('no decision date');
  });
});

describe('D10 shallow clones are left undated', () => {
  it('a depth-1 clone leaves an undated ADR undated, the full repo gives the real date', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0030-old.md', '# Old\n\nStorage: blobs go to S3 because the disks filled twice in 2019.');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'old'], '2019-01-02T00:00:00+00:00');
    writeFileSync(join(repo, 'other.txt'), 'x');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'later'], '2025-06-06T00:00:00+00:00');
    expect(await dateOf('0030-old.md')).toBe('2019-01-02T00:00:00.000Z');
    const clone = mkdtempSync(join(tmpdir(), 'align-2114-clone-'));
    try {
      await execa('git', ['clone', '-q', '--depth', '1', `file://${repo}`, clone]);
      const { items } = await fetchDocsItems({ limit: 50, cwd: clone });
      const hit = items.find((i) => i.source_url.endsWith('0030-old.md'));
      expect(hit).toBeDefined();
      expect(hit).not.toHaveProperty('created_at');
    } finally { rmSync(clone, { recursive: true, force: true }); }
  });
});

describe('D11 only the header declares the date', () => {
  it('ignores a Date line inside a fenced code block', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0031-f.md', `# F\n\n\`\`\`\nDate: 2020-01-01\n\`\`\`\n\n## Context\n\n${BODY}`);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'f'], '2022-02-02T00:00:00+00:00');
    expect(await dateOf('0031-f.md')).toBe('2022-02-02T00:00:00.000Z');
  });
  it('ignores a blockquoted Date line, in the header and in Context', async () => {
    await git(['init', '-q', '-b', 'main']);
    adr('0032-q.md', `# Q\n\n> Date: 2020-01-01\n\n## Context\n\n> Date: 2019-01-01\n\n${BODY}`);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'q'], '2022-03-03T00:00:00+00:00');
    expect(await dateOf('0032-q.md')).toBe('2022-03-03T00:00:00.000Z');
  });
  it('lets front matter beat a late body Date line (revision log)', async () => {
    adr('0033-l.md', `---\ndate: 2020-01-01\n---\n# L\n\n## Context\n\n${BODY}\n\n## Revision log\n\nDate: 2021-01-01\n`);
    expect(await dateOf('0033-l.md')).toBe('2020-01-01');
  });
  it('reads a Date line before the first heading when the title has no front matter', async () => {
    adr('0034-h.md', `# H\n\nDate: 2018-08-08\n\n## Status\n\nAccepted\n\n## Context\n\n${BODY}`);
    expect(await dateOf('0034-h.md')).toBe('2018-08-08');
  });
  it('AsciiDoc: a Date line after the first == section does not count', async () => {
    adr('0035-a.adoc', `= A\n:revdate: 2017-07-07\n\n== Context\n\nDate: 2021-01-01\n\n${BODY}`);
    adr('0036-b.adoc', `= B\n\n== Context\n\nDate: 2021-01-01\n\n${BODY}`);
    expect(await dateOf('0035-a.adoc')).toBe('2017-07-07');
    expect(await dateOf('0036-b.adoc')).toBeUndefined();
  });
  // The fence body is 3 lines with the Date on the last one, so stripping only a fence's first
  // line (the earlier FENCE bug) leaves the Date in the header and it wins over front matter.
  it('ignores a Date line deep inside a multi-line fenced block', async () => {
    adr('0037-m.md', `---\ndate: 2020-01-01\n---\n# M\n\n\`\`\`yaml\nname: x\nkind: y\nDate: 1999-01-01\n\`\`\`\n\n## Context\n\n${BODY}`);
    adr('0038-t.md', `---\ndate: 2020-01-01\n---\n# T\n\n~~~\na\nb\nDate: 1999-01-01\n~~~\n\n## Context\n\n${BODY}`);
    expect(await dateOf('0037-m.md')).toBe('2020-01-01');
    expect(await dateOf('0038-t.md')).toBe('2020-01-01');
  });
  it('strips an unclosed fence to the end, so its Date line does not count', async () => {
    adr('0039-u.md', `---\ndate: 2020-01-01\n---\n# U\n\n\`\`\`\nfoo\n\nDate: 1999-01-01\n\n## Context\n\n${BODY}`);
    expect(await dateOf('0039-u.md')).toBe('2020-01-01');
  });
  // An unfilled template line has no digits at all: it is not a declaration, so front matter wins.
  it('an unfilled template Date line does not hide the front matter date', async () => {
    adr('0040-p.md', `---\ndate: 2020-01-02\n---\n# P\n\n* Date: {YYYY-MM-DD when the decision was last updated}\n\n## Context\n\n${BODY}`);
    adr('0041-e.md', `---\ndate: 2020-01-03\n---\n# E\n\nDate:\n\n## Context\n\n${BODY}`);
    expect(await dateOf('0040-p.md')).toBe('2020-01-02');
    expect(await dateOf('0041-e.md')).toBe('2020-01-03');
  });
});

describe('D12 earliest add wins with branchy history', () => {
  it('takes the earliest add when two branches add the same path', async () => {
    await git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'seed.txt'), 's');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'seed'], '2018-01-01T00:00:00+00:00');
    await git(['checkout', '-q', '-b', 'side']);
    adr('0037-m.md', '# M\n\nMerging: we rebase because the history must stay linear for bisect.');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'side add'], '2019-09-09T00:00:00+00:00');
    await git(['checkout', '-q', 'main']);
    adr('0037-m.md', '# M\n\nMerging: we rebase because the history must stay linear for bisect.');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'main add'], '2024-04-04T00:00:00+00:00');
    await git(['merge', '-q', '--no-edit', '-X', 'ours', 'side'], '2024-05-05T00:00:00+00:00');
    expect(await dateOf('0037-m.md')).toBe('2019-09-09T00:00:00.000Z');
  });
});

describe('D13 bounded git use', () => {
  it('a git that never answers yields undefined after the timeout', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'align-2114-bin-'));
    try {
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n');
      chmodSync(join(bin, 'git'), 0o755);
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
      const t0 = Date.now();
      expect(await firstCommitDate(repo, 'x.md', { timeoutMs: 200 })).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally { rmSync(bin, { recursive: true, force: true }); }
  });
  it('mapLimit never runs more than the limit at once, and keeps order', async () => {
    let live = 0; let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 10));
      live--; return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(peak).toBe(3);
  });
});

describe('D14 fence scanner follows CommonMark closing rules', () => {
  const committed = async (name: string, text: string): Promise<string | undefined> => {
    await git(['init', '-q', '-b', 'main']);
    adr(name, text);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'x'], '2022-09-09T00:00:00+00:00');
    return dateOf(name);
  };
  const GIT = '2022-09-09T00:00:00.000Z';
  it('a 4-backtick block is not closed by a 3-backtick line', async () => {
    const t = `# F\n\n\`\`\`\`\n\`\`\`\nDate: 1999-01-01\n\`\`\`\`\n\n## Context\n\n${  BODY}`;
    expect(await committed('0040-a.md', t)).toBe(GIT);
  });
  it('a closing marker with trailing text does not close', async () => {
    const t = `# F\n\n\`\`\`\n\`\`\` not a close\nDate: 1999-01-01\n\`\`\`\n\n## Context\n\n${  BODY}`;
    expect(await committed('0041-b.md', t)).toBe(GIT);
  });
  it('an empty fence does not swallow the header Date after it', async () => {
    adr('0042-c.md', `# F\n\n\`\`\`\n\`\`\`\n\nDate: 2021-05-05\n\n## Context\n\n${  BODY}`);
    expect(await dateOf('0042-c.md')).toBe('2021-05-05');
  });
  it('~~~ variant: a ``` line inside does not close, and an empty ~~~ fence is harmless', async () => {
    adr('0043-d.md', `# F\n\n~~~\n\`\`\`\nDate: 1999-01-01\n~~~\n\n~~~\n~~~\n\nDate: 2020-02-02\n\n## Context\n\n${  BODY}`);
    expect(await dateOf('0043-d.md')).toBe('2020-02-02');
  });
  it('an unclosed fence runs to the end of input', async () => {
    const t = '# F\n\n```\nDate: 1999-01-01\n';
    expect(await committed('0044-e.md', t)).toBe(GIT);
  });
});

describe('D15 unfilled front matter date falls through', () => {
  const committed = async (name: string, fmDate: string): Promise<string | undefined> => {
    await git(['init', '-q', '-b', 'main']);
    adr(name, `---\ndate: ${fmDate}\n---\n# F\n\n## Context\n\n${BODY}`);
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'x'], '2022-09-09T00:00:00+00:00');
    return dateOf(name);
  };
  it('date: "" uses the git date', async () => {
    expect(await committed('0045-f.md', '""')).toBe('2022-09-09T00:00:00.000Z');
  });
  it('date: "{YYYY-MM-DD}" uses the git date', async () => {
    expect(await committed('0046-g.md', '"{YYYY-MM-DD}"')).toBe('2022-09-09T00:00:00.000Z');
  });
  it('date: TBD still drops the field', async () => {
    expect(await committed('0047-h.md', 'TBD')).toBeUndefined();
  });
});
