// L1: a sync window overlaps the previous run by design, so the same items arrive again.
// Re-ingesting an item whose stored row would not change must not re-embed it or re-link it:
// it returns { created: false, changed: false } and touches nothing.
//
// The content check reads the `summary` column, which holds exactly what the upsert would
// write (raw_text, for a batch item), so it needs no new column - see ingestOne.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as RepoIdentity from '../lib/repo-identity.js';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.8),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

vi.mock('../lib/repo-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RepoIdentity>()),
  currentRepoIdentity: vi.fn().mockResolvedValue(null),
}));

import { PROVIDER_ENV_VARS } from '../lib/llm-providers.js';
import { cosineSimilarity, getEmbedding } from '../lib/local-embeddings.js';
import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { currentRepoIdentity } from '../lib/repo-identity.js';

const A = { source_url: 'https://github.com/o/r/pull/1', platform: 'github', title: 'Use Postgres for the queue', raw_text: 'Use Postgres for the queue; Redis loses jobs on restart.' };
const B = { source_url: 'https://github.com/o/r/pull/2', platform: 'github', title: 'Queue retries cap at 5', raw_text: 'Queue retries cap at 5 with backoff.' };

describe('ingestBatch unchanged-skip', () => {
  let scratch: string;
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    for (const k of PROVIDER_ENV_VARS) vi.stubEnv(k, undefined);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l1-unchanged-'));
    vi.stubEnv('HOME', scratch);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(scratch, '.config'));
    dbPath = path.join(scratch, 'local.db');
    client = createLocalGatewayClient(dbPath);
    vi.mocked(getEmbedding).mockClear();
    vi.mocked(cosineSimilarity).mockReturnValue(0.8);
    vi.mocked(currentRepoIdentity).mockResolvedValue(null);
  });

  afterEach(() => {
    client.close();
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function linkCount(): number {
    const db = createLocalDb(dbPath);
    try { return db.listLinks().length; } finally { db.close(); }
  }

  it('a first ingest is created and changed', async () => {
    const { snapshots } = await client.ingestBatch([A], { classify: false });
    expect(snapshots[0]).toMatchObject({ created: true, changed: true });
  });

  it('re-ingesting identical items returns created:false, changed:false with no embed and no link', async () => {
    await client.ingestBatch([A, B], { classify: false });
    const linksBefore = linkCount();
    expect(linksBefore).toBeGreaterThan(0); // positive control: the first pass did link
    vi.mocked(getEmbedding).mockClear();

    const { snapshots } = await client.ingestBatch([A, B], { classify: false });

    expect(snapshots.map(s => [s.created, s.changed])).toEqual([[false, false], [false, false]]);
    expect(getEmbedding).not.toHaveBeenCalled();
    expect(linkCount()).toBe(linksBefore);
  });

  it('an edited body under the same identity is changed and re-embedded', async () => {
    await client.ingestBatch([A], { classify: false });
    vi.mocked(getEmbedding).mockClear();

    const { snapshots } = await client.ingestBatch([{ ...A, raw_text: `${A.raw_text} Revised: use SQS.` }], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    expect(getEmbedding).toHaveBeenCalledTimes(1);
  });

  it('a date arriving for a row stored without one is a change, so the date is not skipped', async () => {
    await client.ingestBatch([A], { classify: false });
    const { snapshots } = await client.ingestBatch([{ ...A, created_at: '2026-09-01T10:00:00Z' }], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    const db = createLocalDb(dbPath);
    try { expect(db.getDecisionById(snapshots[0].id)?.decidedAt).toBeTruthy(); } finally { db.close(); }
  });

  // A citation link is not a similarity link. Today a citer that arrives AFTER its target is
  // linked only when the target is ingested again (resolveRefs runs on the target's ingest),
  // so the skip must keep that cheap step or a re-sync stops healing the gap.
  it('an unchanged re-ingest still resolves a citation that arrived after the target', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.1); // below every floor: no similarity links
    await client.ingestBatch([A], { classify: false });
    const citer = { source_url: 'https://x.atlassian.net/browse/ALI-12', platform: 'jira', title: 'ALI-12', raw_text: `Queue work follows ${A.source_url}` };
    await client.ingestBatch([citer], { classify: false });
    expect(linkCount()).toBe(0);

    const { snapshots } = await client.ingestBatch([A], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: false });
    expect(linkCount()).toBe(1);
  });

  it('the same item under a different platform is a change, and the platform is rewritten', async () => {
    await client.ingestBatch([A], { classify: false });
    const { snapshots } = await client.ingestBatch([{ ...A, platform: 'gitlab' }], { classify: false });
    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    const db = createLocalDb(dbPath);
    try { expect(db.getDecisionById(snapshots[0].id)?.platform).toBe('gitlab'); } finally { db.close(); }
  });

  it('a repo resolved for a row stored without one is a change, so the repo lands', async () => {
    // A git item with no hosted URL takes the CURRENT repo. First run: outside any repo.
    const commit = { source_url: 'file:///work/abc123', platform: 'git', title: 'Pin node 22', raw_text: 'Pin node 22 in CI.' };
    await client.ingestBatch([commit], { classify: false });
    client.close();
    vi.mocked(currentRepoIdentity).mockResolvedValue('o/r');
    client = createLocalGatewayClient(dbPath); // the current repo is memoised per client

    const { snapshots } = await client.ingestBatch([commit], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    const db = createLocalDb(dbPath);
    try { expect(db.getDecisionById(snapshots[0].id)?.repo).toBe('o/r'); } finally { db.close(); }
  });

  it('an embedding from a retired model is a change, so the row is re-embedded', async () => {
    const first = await client.ingestBatch([A], { classify: false });
    const db = createLocalDb(dbPath);
    try { db.setEmbedding(first.snapshots[0].id, new Float32Array(384).fill(0.2), 'retired-model'); } finally { db.close(); }
    vi.mocked(getEmbedding).mockClear();

    const { snapshots } = await client.ingestBatch([A], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    expect(getEmbedding).toHaveBeenCalledTimes(1);
  });

  it('a re-import with NO repo for a row that has one stays unchanged (the stored repo is kept)', async () => {
    const commit = { source_url: 'file:///work/def456', platform: 'git', title: 'Drop node 20', raw_text: 'Drop node 20 support.' };
    vi.mocked(currentRepoIdentity).mockResolvedValue('o/r');
    await client.ingestBatch([commit], { classify: false });
    client.close();
    vi.mocked(currentRepoIdentity).mockResolvedValue(null);
    client = createLocalGatewayClient(dbPath);
    vi.mocked(getEmbedding).mockClear();

    const { snapshots } = await client.ingestBatch([commit], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: false });
    expect(getEmbedding).not.toHaveBeenCalled();
  });

  it('a re-import with NO date for a row that has one stays unchanged (the stored date is kept)', async () => {
    await client.ingestBatch([{ ...A, created_at: '2026-09-01T10:00:00Z' }], { classify: false });
    vi.mocked(getEmbedding).mockClear();

    const { snapshots } = await client.ingestBatch([A], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: false });
    expect(getEmbedding).not.toHaveBeenCalled();
  });

  it('an unchanged re-import still re-extracts refs, so a better extractor backfills them', async () => {
    const citing = { ...B, raw_text: `Queue retries cap at 5, per ${A.source_url}` };
    const first = await client.ingestBatch([citing], { classify: false });
    const id = first.snapshots[0].id;
    // Stand-in for a row written by an older extractor that found nothing.
    let db = createLocalDb(dbPath);
    try { db.replaceRefs(id, []); } finally { db.close(); }

    const { snapshots } = await client.ingestBatch([citing], { classify: false });

    expect(snapshots[0]).toMatchObject({ created: false, changed: false });
    db = createLocalDb(dbPath);
    try { expect(db.getRefs(id)).toEqual([{ ref: A.source_url, platform: 'github' }]); } finally { db.close(); }
  });

  // The skip is for connector imports only. Human and agent capture re-rank on every capture,
  // because what is similar to a decision changes as the graph grows.
  it('ingestBatch without classify:false re-ingests an unchanged item in full', async () => {
    await client.ingestBatch([A, B]);
    vi.mocked(getEmbedding).mockClear();

    const { snapshots } = await client.ingestBatch([A]);

    expect(snapshots[0]).toMatchObject({ created: false, changed: true });
    expect(getEmbedding).toHaveBeenCalledTimes(1);
  });

  it('re-capturing an unchanged URL with captureDecision re-embeds and returns related decisions', async () => {
    await client.ingestBatch([B], { classify: false });
    await client.captureDecision('https://github.com/o/r/pull/77', 'cli');
    vi.mocked(getEmbedding).mockClear();

    const again = await client.captureDecision('https://github.com/o/r/pull/77', 'cli');

    expect(getEmbedding).toHaveBeenCalledTimes(1);
    expect(again.related.length).toBeGreaterThan(0);
  });

  it('the same date again is not a change', async () => {
    const dated = { ...A, created_at: '2026-09-01T10:00:00Z' };
    await client.ingestBatch([dated], { classify: false });
    const { snapshots } = await client.ingestBatch([dated], { classify: false });
    expect(snapshots[0]).toMatchObject({ created: false, changed: false });
  });
});
