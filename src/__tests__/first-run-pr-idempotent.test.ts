/**
 * A PR row first run writes and the row `align connect github` writes for the same PR are
 * ONE decision, so running the connector afterwards (or first run twice) never duplicates it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { fetchFirstRunPrs } from '../lib/first-run-pr-import.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

const BECAUSE = 'The router rebuilt its table on every request because the cache key ignored the prefix.';

async function firstRunItems(numbers: number[]) {
  const rows = numbers.map((n) => ({
    number: n, title: `fix: router cache ${n}`, body: BECAUSE, merged_at: '2026-03-08T10:00:00Z', html_url: `https://github.com/acme/widgets/pull/${n}`,
    updated_at: '2026-03-09T00:00:00Z', user: { login: 'ada', type: 'User' }, base: { repo: { full_name: 'acme/widgets' } },
  }));
  const fetchFn = (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;
  return (await fetchFirstRunPrs('github.com/acme/widgets', { fetchFn, detectToken: async () => null })).items;
}

describe('first-run PR rows and `align connect github`', () => {
  let dir: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-prrow-')); client = createLocalGatewayClient(path.join(dir, 'local.db')); });
  afterEach(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const count = (sourceUrl: string) => {
    const db = createLocalDb(path.join(dir, 'local.db'));
    try { return db.listDecisions().filter((d) => d.sourceUrl === sourceUrl).length; } finally { db.close(); }
  };

  it('first run twice leaves one row per PR', async () => {
    const items = await firstRunItems([7, 8]);
    await client.ingestBatch(items, { classify: false, keyed: true });
    await client.ingestBatch(items, { classify: false, keyed: true });
    expect(count('https://github.com/acme/widgets/pull/7')).toBe(1);
    expect(count('https://github.com/acme/widgets/pull/8')).toBe(1);
  });

  it('the connector read of the same PR (with its discussion appended) lands on the same row', async () => {
    const [first] = await firstRunItems([7]);
    await client.ingestBatch([first!], { classify: false, keyed: true });
    // what connector-core's GitHubFetcher returns for the same PR: same url, same title, discussion added
    const viaConnector = { ...first!, source_url: 'https://github.com/acme/widgets/pull/7', title: 'fix: router cache 7', platform: 'github', created_at: '2026-01-01T00:00:00.000Z', raw_text: `${first!.raw_text}\n\n## Comments\n[bob] (2026-03-09):\nLooks good.` };
    await client.ingestBatch([viaConnector], { classify: false, keyed: true });
    expect(count('https://github.com/acme/widgets/pull/7')).toBe(1);
  });
});
