/**
 * ALI-798: the actual retrieval rule on top of the storage-layer primitives tested in
 * local-db-repo-scope.test.ts - ingestOne stamping a repo at import time, and
 * searchDecisions/listDecisions defaulting to "current repo, or all outside a git repo".
 *
 * Test List:
 * 1. ingestBatch stamps repo from a hosted source_url regardless of which platform sent it
 * 2. a 'git' item with NO hosted remote (a remoteless commit) falls back to the CURRENT repo
 * 3. a non-git item (jira/slack) with no hosted URL never gets the current-repo fallback
 * 4. searchDecisions inside repo A returns A's decisions and unattributed ones, not B's
 * 5. searchDecisions with `{ all: true }` returns everything regardless of current repo
 * 6. searchDecisions outside a git repo defaults to everything (nothing to scope to)
 * 7. listDecisions mirrors the same two rules (scoped default, `{ all: true }` override)
 * 8. the returned scope names which repo a scoped search answered from
 */
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the last test in this file ranks by similarity - the rest exercise plain SQL
// row-visibility (ingestBatch + listDecisions), which does not touch cosineSimilarity at
// all. Mocked file-wide anyway (local-search-enrichment.test.ts does the same): reading a
// score out of the stored embedding's first element, rather than trusting the real MiniLM
// model to rank "database choice" above SEARCH_THRESHOLD against "Use Postgres for the API
// service", is what keeps that one test's fixture deterministic instead of coincidental.
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0)),
  cosineSimilarity: vi.fn((_q: Float32Array, stored: Float32Array) => stored[0]),
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

let dir: string;
let dbPath: string;
let client: ReturnType<typeof createLocalGatewayClient> | undefined;

beforeEach(() => {
  client = undefined;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali798-client-'));
  dbPath = path.join(dir, 'graph.db');
});

afterEach(() => {
  client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ingestBatch stamps repo at import time', () => {
  it('from a hosted source_url, regardless of platform', async () => {
    client = createLocalGatewayClient(dbPath);
    await client.ingestBatch([
      { source_url: 'https://github.com/acme/api/pull/9', platform: 'github', raw_text: 'Use Postgres', title: 'Use Postgres' },
    ]);
    // Filtering to the repo the stamp should have written proves it landed - a filter
    // against the wrong repo (or an unstamped null) would find nothing.
    const scoped = await client.listDecisions({ repo: 'github.com/acme/api' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].title).toBe('Use Postgres');
  });

  it('a remoteless git commit falls back to the CURRENT repo', async () => {
    await execa('git', ['init'], { cwd: dir });
    await execa('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir });
    client = createLocalGatewayClient(dbPath, { cwd: dir });
    await client.ingestBatch([
      { source_url: 'git://commit/abc1234', platform: 'git', raw_text: 'Adopt token-bucket rate limiting', title: 'Adopt rate limiting' },
    ]);
    // Scoped retrieval from inside `dir` must find it - proving the stamp landed as
    // github.com/acme/widgets, not left null.
    const scoped = await client.listDecisions({});
    expect(scoped).toHaveLength(1);
  });

  it('a non-git item with no hosted URL never gets the current-repo fallback', async () => {
    await execa('git', ['init'], { cwd: dir });
    await execa('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir });
    client = createLocalGatewayClient(dbPath, { cwd: dir });
    await client.ingestBatch([
      { source_url: 'https://acme.atlassian.net/browse/X-1', platform: 'jira', raw_text: 'Adopt SSO', title: 'Adopt SSO' },
    ]);
    // Scoped to a DIFFERENT repo entirely, includeUnattributed (the default) still
    // surfaces it - proving it was stamped null, not misattributed to acme/widgets (the
    // CURRENT repo, which the git-only fallback must not have reached for a jira item).
    const other = createLocalGatewayClient(dbPath, { cwd: '/tmp/does-not-matter' });
    const rows = await other.listDecisions({ repo: 'github.com/some/other-repo' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Adopt SSO');
    other.close();
  });
});

describe('resolving a --repo argument against what is in the graph', () => {
  it('accepts a short name and an owner/repo suffix, not just the full identity', async () => {
    const raw = createLocalDb(dbPath);
    raw.insertDecision({ title: 'A', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/1', platform: 'github', repo: 'github.com/acme/api' });
    raw.close();
    client = createLocalGatewayClient(dbPath);

    expect(await client.listDecisions({ repo: 'api' })).toHaveLength(1);
    expect(await client.listDecisions({ repo: 'acme/api' })).toHaveLength(1);
    expect(await client.listDecisions({ repo: 'github.com/acme/api' })).toHaveLength(1);
  });

  it('throws, naming the candidates, when a short name matches more than one repo', async () => {
    const raw = createLocalDb(dbPath);
    raw.insertDecision({ title: 'A', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/1', platform: 'github', repo: 'github.com/acme/api' });
    raw.insertDecision({ title: 'B', summary: 's', sourceUrl: 'https://gitlab.com/other/api/-/commit/abc1234', platform: 'git', repo: 'gitlab.com/other/api' });
    raw.close();
    client = createLocalGatewayClient(dbPath);

    await expect(client.listDecisions({ repo: 'api' })).rejects.toThrow(/matches more than one repo/);
  });

  it('falls through to the literal argument on no match - an honest empty result, not a guess', async () => {
    client = createLocalGatewayClient(dbPath);
    expect(await client.listDecisions({ repo: 'nothing-like-this-exists' })).toHaveLength(0);
  });
});

describe('retrieval scoping', () => {
  async function seedTwoRepos() {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ali798-repoA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ali798-repoB-'));
    await execa('git', ['init'], { cwd: dirA });
    await execa('git', ['remote', 'add', 'origin', 'git@github.com:acme/api.git'], { cwd: dirA });
    await execa('git', ['init'], { cwd: dirB });
    await execa('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: dirB });

    const seeder = createLocalGatewayClient(dbPath);
    await seeder.ingestBatch([
      { source_url: 'https://github.com/acme/api/pull/1', platform: 'github', raw_text: 'Use Postgres for the API service', title: 'Use Postgres' },
      { source_url: 'https://github.com/acme/web/pull/1', platform: 'github', raw_text: 'Use SvelteKit for the web frontend', title: 'Use SvelteKit' },
      { source_url: 'https://acme.atlassian.net/browse/X-1', platform: 'jira', raw_text: 'Adopt a shared design system', title: 'Adopt design system' },
    ]);
    seeder.close();
    return { dirA, dirB };
  }

  it('inside repo A: returns A and the unattributed row, not B', async () => {
    const { dirA, dirB } = await seedTwoRepos();
    client = createLocalGatewayClient(dbPath, { cwd: dirA });
    const rows = await client.listDecisions({});
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Adopt design system', 'Use Postgres']);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('with `all: true`, returns everything regardless of the current repo', async () => {
    const { dirA, dirB } = await seedTwoRepos();
    client = createLocalGatewayClient(dbPath, { cwd: dirA });
    const rows = await client.listDecisions({ all: true });
    expect(rows).toHaveLength(3);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('outside a git repo, defaults to everything - nothing to scope to', async () => {
    const { dirA, dirB } = await seedTwoRepos();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ali798-outside-'));
    client = createLocalGatewayClient(dbPath, { cwd: outside });
    const rows = await client.listDecisions({});
    expect(rows).toHaveLength(3);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('an explicit --repo targets a repo other than the current one', async () => {
    const { dirA, dirB } = await seedTwoRepos();
    client = createLocalGatewayClient(dbPath, { cwd: dirA });
    const rows = await client.listDecisions({ repo: 'github.com/acme/web' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Adopt design system', 'Use SvelteKit']);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('searchDecisions scopes the same way and names the repo it answered from', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ali798-searchA-'));
    await execa('git', ['init'], { cwd: dirA });
    await execa('git', ['remote', 'add', 'origin', 'git@github.com:acme/api.git'], { cwd: dirA });

    // Seeded directly (not via ingestBatch): cosineSimilarity is mocked to read the stored
    // embedding's first element, so both rows rank ABOVE SEARCH_THRESHOLD regardless of
    // query text - the fixture is built from the threshold, not from a hope that a real
    // model agrees "database choice" is about Postgres.
    const raw = createLocalDb(dbPath);
    const inA = raw.insertDecision({ title: 'Use Postgres', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/1', platform: 'github', repo: 'github.com/acme/api' });
    raw.setEmbedding(inA, (() => { const e = new Float32Array(384).fill(0); e[0] = 0.9; return e; })());
    const inB = raw.insertDecision({ title: 'Use SvelteKit', summary: 's', sourceUrl: 'https://github.com/acme/web/pull/1', platform: 'github', repo: 'github.com/acme/web' });
    raw.setEmbedding(inB, (() => { const e = new Float32Array(384).fill(0); e[0] = 0.9; return e; })());
    raw.close();

    client = createLocalGatewayClient(dbPath, { cwd: dirA });
    const scoped = await client.searchDecisions('database choice', 10);
    expect(scoped.scope).toBe('github.com/acme/api');
    expect(scoped.results.map((r) => r.title)).toContain('Use Postgres');
    expect(scoped.results.map((r) => r.title)).not.toContain('Use SvelteKit');

    const all = await client.searchDecisions('database choice', 10, { all: true });
    expect(all.scope).toBeNull();
    expect(all.results.map((r) => r.title)).toContain('Use SvelteKit');
    fs.rmSync(dirA, { recursive: true, force: true });
  });
});
