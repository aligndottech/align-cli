import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * align_ask answered a question about this system with two unrelated decisions at 0.18 and
 * 0.14 similarity, no repository names and no links, so the agent discarded them and read
 * the code instead. Three separate causes, all in local searchDecisions:
 *
 *   1. a 0.1 similarity floor, when every other threshold in this file is 0.45-0.65
 *   2. source_url and platform fetched from SQLite and then dropped on the floor, so
 *      nothing downstream can name the repository a decision came from
 *   3. no repository/cite derivation at all, which mcp-align has had since #1441
 *
 * The mocked boundary is only the on-device embedding model, matching
 * local-query-integration.test.ts. cosineSimilarity reads the score out of the stored
 * embedding's first element so a fixture can sit precisely either side of the floor.
 */
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn((_q: Float32Array, stored: Float32Array) => stored[0]),
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue(null),
}));
vi.mock('../lib/local-llm.js', () => ({ synthesiseLocally: vi.fn().mockResolvedValue(null) }));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

let dir = '';
let dbPath = '';

/** Insert a decision whose similarity to any query is exactly `score`. */
function seed(
  db: ReturnType<typeof createLocalDb>,
  opts: { title: string; sourceUrl: string | null; platform: string; score: number },
): string {
  const id = db.insertDecision({
    title: opts.title,
    summary: `${opts.title} summary`,
    sourceUrl: opts.sourceUrl,
    platform: opts.platform,
  });
  const emb = new Float32Array(384).fill(0);
  emb[0] = opts.score;
  db.setEmbedding(id, emb);
  return id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-search-'));
  dbPath = path.join(dir, 'align.db');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local searchDecisions gives an agent enough to cite a decision', () => {
  it('carries source_url, repository and cite for a decision that came from code', async () => {
    const db = createLocalDb(dbPath);
    seed(db, {
      title: "Add explicit 'unknown' state",
      sourceUrl: 'https://github.com/aligndottech/align-cli/pull/76',
      platform: 'github',
      score: 0.9,
    });

    const client = createLocalGatewayClient(dbPath);
    const res = await client.searchDecisions('does the check fail open');

    // Positive control: the fixture produced a result before anything is asserted about it.
    expect(res.results).toHaveLength(1);
    const d = res.results[0] as Record<string, unknown>;
    expect(d['source_url']).toBe('https://github.com/aligndottech/align-cli/pull/76');
    expect(d['repository']).toBe('aligndottech/align-cli');
    expect(d['cite']).toBe('align-cli#76');
  });

  // Second example on a DIFFERENT host, so the rule is "parse the path shape" and not
  // "github.com". A self-hosted tenant on GitHub Enterprise Server is the whole reason
  // mcp-align's reader is not host-anchored, and this repo ships to those tenants too.
  it('derives the repository on a self-hosted GitHub Enterprise host', async () => {
    const db = createLocalDb(dbPath);
    seed(db, {
      title: 'Pin the ingest batch size',
      sourceUrl: 'https://github.acme-corp.internal/platform/ingest/pull/412',
      platform: 'github',
      score: 0.9,
    });

    const client = createLocalGatewayClient(dbPath);
    const res = await client.searchDecisions('batch size');

    expect(res.results).toHaveLength(1);
    const d = res.results[0] as Record<string, unknown>;
    expect(d['repository']).toBe('platform/ingest');
    expect(d['cite']).toBe('ingest#412');
  });

  // A negative assertion needs a positive control in the same test, or an empty world
  // satisfies it. Both decisions are returned by the same call; only one is from code.
  it('omits repository and cite for a decision that did not come from code', async () => {
    const db = createLocalDb(dbPath);
    seed(db, { title: 'From Slack', sourceUrl: 'https://acme.slack.com/archives/C1/p123', platform: 'slack', score: 0.9 });
    seed(db, { title: 'From a PR', sourceUrl: 'https://github.com/aligndottech/align-cli/pull/76', platform: 'github', score: 0.8 });

    const client = createLocalGatewayClient(dbPath);
    const res = await client.searchDecisions('anything');

    expect(res.results).toHaveLength(2);
    const slack = res.results.find(r => r.title === 'From Slack') as Record<string, unknown>;
    const pr = res.results.find(r => r.title === 'From a PR') as Record<string, unknown>;
    // The control: the reader CAN produce a repository, so its absence on the Slack
    // decision is the URL shape and not a broken derivation.
    expect(pr['repository']).toBe('aligndottech/align-cli');
    expect(slack['repository']).toBeUndefined();
    expect(slack['cite']).toBeUndefined();
    // source_url still travels: losing the origin would be a worse answer, not a safer one.
    expect(slack['source_url']).toBe('https://acme.slack.com/archives/C1/p123');
  });

  // Deliberately NOT emitted here, unlike mcp-align. A local-embedded decision exists only
  // in this machine's SQLite file, so any Align URL built for it 404s wherever it points -
  // and a fabricated link is worse than none because it looks clickable.
  it('does not invent an Align decision_url for a locally-stored decision', async () => {
    const db = createLocalDb(dbPath);
    seed(db, { title: 'Local only', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github', score: 0.9 });

    const client = createLocalGatewayClient(dbPath);
    const res = await client.searchDecisions('anything');

    expect(res.results).toHaveLength(1);
    // Control first: enrichment ran on this row, so the missing field is a decision
    // rather than a code path that never executed.
    expect((res.results[0] as Record<string, unknown>)['repository']).toBe('o/r');
    expect(res.results[0]).not.toHaveProperty('decision_url');
  });
});

describe('local searchDecisions applies a real relevance floor', () => {
  // Built FROM the boundary. 0.18 is the similarity align_ask actually returned as a
  // "result"; 0.30 is the nearest value above the floor. One either side, so the test
  // fails if the floor moves in either direction rather than only if it disappears.
  it('excludes a match below the floor and keeps one above it', async () => {
    const db = createLocalDb(dbPath);
    seed(db, { title: 'Noise at 0.18', sourceUrl: null, platform: 'cli', score: 0.18 });
    seed(db, { title: 'Relevant at 0.30', sourceUrl: null, platform: 'cli', score: 0.3 });

    const client = createLocalGatewayClient(dbPath);
    const res = await client.searchDecisions('does the check fail open');

    expect(res.results.map(r => r.title)).toEqual(['Relevant at 0.30']);
  });

  // The other side of the same rule: everything below the floor must yield an HONEST
  // empty result. That is a better answer than two wrong ones - the agent can say the
  // graph has nothing rather than having to judge decimals itself.
  it('returns nothing rather than noise when every match is below the floor', async () => {
    const db = createLocalDb(dbPath);
    seed(db, { title: 'gRPC seed data', sourceUrl: null, platform: 'cli', score: 0.1846 });
    seed(db, { title: 'More seed data', sourceUrl: null, platform: 'cli', score: 0.1425 });

    const client = createLocalGatewayClient(dbPath);
    const res = await client.searchDecisions('what happens when the brain service is down');

    expect(res.results).toEqual([]);
    expect(res.count).toBe(0);
  });
});
