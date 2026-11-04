import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { fetchDocsItems } from '../../lib/fetchers/docs.js';

/**
 * The rules a repo keeps in README.md, CONTRIBUTING.md and its changelog's convention
 * sections. Measured on recart/openapi: no ADRs and no CLAUDE.md, so `connect docs` imported
 * nothing while the repo's real rules ("add an entry to docs/changelog.md in the same PR",
 * the versioning policy) sat in README.md and docs/changelog.md.
 *
 * Both directions are pinned: a rule-bearing section becomes an item, and install steps or a
 * changelog's dated release entries do not.
 */
const RECART_README = `# openapi
Recart's OpenAPI specification

## Updating the changelog

Every notable API change is tracked in [\`docs/changelog.md\`](docs/changelog.md) and exposed as an RSS/Atom feed via GitHub Releases.

- **REST API** - date-based, pinned versions (\`2023-12\`). Additive changes stay on the current version; breaking changes get a new dated version.

When you change either surface:

1. **Add an entry to \`docs/changelog.md\`** in the same PR, under the matching track.
2. **After merge, cut a GitHub Release** whose notes mirror the entry.
`;

const RECART_CHANGELOG = `---
stoplight-id:
---

# Changelog

All notable changes to Recart's developer surfaces are documented here.

## Versioning

### REST API - date-based, pinned

- **Additive, backward-compatible changes** ship into the **current** version - changelog entry only, no version bump.
- **Breaking changes** create a **new dated version** that runs side-by-side, so existing integrations keep working.

---

## REST API

### [2023-12.2] - 2026-07-07

#### Deprecated
- The \`shopperId\` field is deprecated. Clients must stop reading it.

### [2023-12.1] - 2026-06-24

#### Added
- \`PATCH /subscribers\` endpoint for updating subscribers with custom attributes.
`;

function mockGit(): void {
  vi.mocked(execa).mockImplementation(async (_cmd, args) => {
    const a = args as string[];
    if (a[0] === 'remote') return { stdout: 'https://github.com/acme/api' } as Awaited<ReturnType<typeof execa>>;
    if (a[0] === 'rev-parse') return { stdout: 'main' } as Awaited<ReturnType<typeof execa>>;
    throw new Error(`unexpected git invocation: ${a.join(' ')}`);
  });
}

describe('fetchDocsItems - README, CONTRIBUTING and changelog conventions', () => {
  let repo: string;
  const write = (rel: string, content: string): void => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };
  const fresh = (): void => {
    repo = mkdtempSync(join(tmpdir(), 'align-readme-rules-'));
    mockGit();
  };
  afterEach(() => {
    vi.clearAllMocks();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('turns the README changelog passage into a rule, titled by its heading and anchored in README.md', async () => {
    fresh();
    write('README.md', RECART_README);
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    const rule = items.find((i) => i.title === 'Updating the changelog');
    expect(rule).toBeDefined();
    expect(rule!.platform).toBe('docs');
    expect(rule!.source_url).toBe('https://github.com/acme/api/blob/main/README.md#updating-the-changelog');
    expect(rule!.raw_text).toContain('Add an entry to `docs/changelog.md`** in the same PR');
    expect(rule!.raw_text).toContain('breaking changes get a new dated version');
  });

  it('does not import README sections that are not rules (install and usage steps)', async () => {
    fresh();
    write('README.md', `${RECART_README}\n## Installation\n\nRun npm install. You must have Node 20 installed first.\n\n## Usage\n\nCall the client with your key and read the response.\n`);
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items.map((i) => i.title)).toEqual(['Updating the changelog']);
  });

  it('reads CONTRIBUTING.md from the root, .github/ and docs/, importing only its rule sections', async () => {
    fresh();
    write('CONTRIBUTING.md', '# Contributing\n\n## Commits\n\nEvery commit must reference a ticket. Never force-push to main.\n\n## Thanks\n\nThank you for helping out with this project!\n');
    write('.github/CONTRIBUTING.md', '## Reviews\n\nAll changes must be reviewed by one other maintainer before merging.\n');
    write('docs/CONTRIBUTING.md', '## Tests\n\nNew behaviour must ship with a test that failed first.\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items.map((i) => i.title).sort()).toEqual(['Commits', 'Reviews', 'Tests']);
  });

  it('imports a changelog Versioning section but none of its dated release entries', async () => {
    fresh();
    write('docs/changelog.md', RECART_CHANGELOG);
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items.map((i) => i.title)).toEqual(['Versioning']);
    expect(items[0].raw_text).toContain('Breaking changes');
    const all = items.map((i) => i.raw_text).join('\n');
    expect(all).not.toContain('2023-12.2');
    expect(all).not.toContain('shopperId');
    expect(all).not.toContain('PATCH /subscribers');
  });

  it('drops a Keep-a-Changelog release entry even when its text says "must"', async () => {
    fresh();
    write('CHANGELOG.md', '# Changelog\n\n## [1.2.0] - 2026-01-01\n\n### Changed\n- Clients must now send an API key. Never call without one.\n\n## Unreleased\n\n- Everyone must upgrade.\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items).toEqual([]);
  });

  it('counts the sections it left out in the capture report', async () => {
    fresh();
    write('README.md', `${RECART_README}\n## Installation\n\nRun npm install. You must have Node 20 installed first.\n`);
    const { report } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(report.skips).toEqual([
      expect.objectContaining({ count: 1, detail: expect.stringContaining('state no rule') }),
    ]);
  });
});

describe('fetchDocsItems - co-change rule shape', () => {
  let repo: string;
  const fresh = (): void => {
    repo = mkdtempSync(join(tmpdir(), 'align-readme-rules-'));
    mockGit();
  };
  afterEach(() => {
    vi.clearAllMocks();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('puts when_paths / require_paths / same_pr on the changelog rule, inferring the spec dir from the tree', async () => {
    fresh();
    writeFileSync(join(repo, 'README.md'), RECART_README);
    mkdirSync(join(repo, 'openapi'));
    writeFileSync(join(repo, 'openapi', '2023-12.yaml'), 'openapi: 3.0.0\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    const rule = items.find((i) => i.title === 'Updating the changelog') as { co_change_rule?: unknown } | undefined;
    expect(rule?.co_change_rule).toEqual({
      when_paths: ['openapi/**'],
      require_paths: ['docs/changelog.md'],
      scope: 'same_pr',
    });
  });

  it('takes the trigger dir from the text when the section names one, and the required file from its own wording', async () => {
    fresh();
    writeFileSync(join(repo, 'CONTRIBUTING.md'), '## Changelog\n\nAny change under `src/api/` must add an entry to `CHANGELOG.md` in the same PR.\n');
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    const rule = items[0] as { co_change_rule?: unknown };
    expect(rule.co_change_rule).toEqual({
      when_paths: ['src/api/**'],
      require_paths: ['CHANGELOG.md'],
      scope: 'same_pr',
    });
  });

  it('emits no structured rule when it cannot tell what triggers it (the text is still imported)', async () => {
    fresh();
    writeFileSync(join(repo, 'README.md'), RECART_README); // no openapi/ dir, no path in the text
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('co_change_rule');
  });

  it('emits none on a section that is not a same-PR requirement', async () => {
    fresh();
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'changelog.md'), '## Versioning\n\nBreaking changes must create a new dated version. Never edit a released one.\n');
    mkdirSync(join(repo, 'openapi'));
    const { items } = await fetchDocsItems({ limit: 100, cwd: repo });
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('co_change_rule');
  });
});

// Reads the real Recart README when the replay scratch copy is present; skipped in CI.
const REAL = process.env['RECART_OPENAPI_DIR'];
describe.skipIf(!REAL)('recart/openapi replay', () => {
  it('imports the README changelog rule and the changelog Versioning section', async () => {
    mockGit();
    const { items } = await fetchDocsItems({ limit: 100, cwd: REAL });
    expect(items.map((i) => i.title)).toEqual(expect.arrayContaining(['Updating the changelog', 'Versioning']));
  });
});
