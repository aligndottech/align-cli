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

  it('splits a numbered list of rules', async () => {
    const items = await importAgents('## Rules\n\n1. Never commit a secret.\n2. Always run the tests.\n3. Ask before deleting files.\n');
    expect(items).toHaveLength(3);
    expect(items[2]!.title).toBe('Ask before deleting files.');
  });

  it('caps one section at 30 rules', async () => {
    const list = Array.from({ length: 40 }, (_, i) => `- Never touch file number ${i} directly.`).join('\n');
    const items = await importAgents(`## Rules\n\n${list}\n`);
    expect(items).toHaveLength(30);
  });

  it('puts the whole rule in the title even when it is long, so DECISIONS.md carries it', async () => {
    const long = 'Never force-push to main or run git reset --hard without asking first, because other people and other agents build on that branch and a rewritten history strands their work';
    const items = await importAgents(`## Rules\n\n- ${long}.\n- Always run the tests.\n- Ask before deleting files.\n`);
    expect(items[0]!.title).toBe(`${long}.`);
  });
});
