import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

// ALI-796: the payoff of the gap-driven pull, wired through the ingest path a real
// import uses. A decision citing a Jira key that nothing can read yet becomes a real
// graph link the moment the Jira issue is imported - "resolve refs into real links
// where the fetched item matches".
describe('resolving refs at ingest (ALI-796)', () => {
  let dir: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-resolve-'));
    client = createLocalGatewayClient(path.join(dir, 'local.db'));
  });

  afterEach(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links a pre-existing citing decision once the cited Jira issue is imported', async () => {
    const { snapshots: gitBatch } = await client.ingestBatch([{
      raw_text: 'feat(auth): switch to JWT\n\nRefs ALI-123.',
      title: 'feat(auth): switch to JWT',
      source_url: 'https://github.com/align/cli/commit/abc1234def',
      platform: 'git',
    }]);
    const citerId = gitBatch[0].id;

    const { snapshots: jiraBatch } = await client.ingestBatch([{
      raw_text: 'Switch auth to JWT for stateless sessions',
      title: 'ALI-123: Switch auth to JWT',
      source_url: 'https://acme.atlassian.net/browse/ALI-123',
      platform: 'jira',
    }]);
    const jiraId = jiraBatch[0].id;

    // getImpact's `upstream` is every link whose TARGET is this decision - the citer
    // points AT the newly-resolved Jira decision, so it shows up there.
    const { upstream } = await client.getImpact(jiraId);
    expect(upstream).toContainEqual(
      expect.objectContaining({ sourceId: citerId, targetId: jiraId, relation: 'relates' }),
    );
  });

  it('does not link when nothing cites the imported key', async () => {
    const { snapshots: jiraBatch } = await client.ingestBatch([{
      raw_text: 'Switch auth to JWT for stateless sessions',
      title: 'ALI-123: Switch auth to JWT',
      source_url: 'https://acme.atlassian.net/browse/ALI-123',
      platform: 'jira',
    }]);
    const { upstream } = await client.getImpact(jiraBatch[0].id);
    expect(upstream).toEqual([]);
  });
});
