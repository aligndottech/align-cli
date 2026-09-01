import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

// ALI-792: refs extracted at ingest are stored beside the decision and surfaced as
// external_references - previously hard-coded [] - so `align decisions show` and the
// gap-driven connect prompt (ALI-796) can read what the decision points at.
describe('refs at ingest', () => {
  let dir: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-refs-'));
    client = createLocalGatewayClient(path.join(dir, 'local.db'));
  });

  afterEach(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const RAW = [
    'feat(auth): switch to JWT for stateless sessions',
    'We decided against server-side sessions. Refs ALI-123 and closes #45.',
    'See https://align.slack.com/archives/C123/p456 for the thread.',
  ].join('\n\n');

  it('stores extracted refs and returns them as external_references', async () => {
    const { snapshots } = await client.ingestBatch([{
      raw_text: RAW,
      title: 'feat(auth): switch to JWT for stateless sessions',
      source_url: 'https://github.com/align/cli/commit/abc1234def',
      platform: 'git',
    }]);
    const d = await client.getDecision(snapshots[0].id);
    expect(d.external_references).toContainEqual({ ref: 'ALI-123', platform: 'tracker' });
    expect(d.external_references).toContainEqual({ ref: '#45', platform: 'code' });
    expect(d.external_references).toContainEqual({
      ref: 'https://align.slack.com/archives/C123/p456',
      platform: 'slack',
    });
  });

  it('does not duplicate refs when the same decision is re-imported', async () => {
    const item = {
      raw_text: RAW,
      title: 'feat(auth): switch to JWT for stateless sessions',
      source_url: 'https://github.com/align/cli/commit/abc1234def',
      platform: 'git',
    };
    const first = await client.ingestBatch([item]);
    const second = await client.ingestBatch([item]);
    expect(second.snapshots[0].id).toBe(first.snapshots[0].id);
    const d = await client.getDecision(second.snapshots[0].id);
    expect(d.external_references).toHaveLength(3);
  });

  it('replaces refs when a re-imported decision no longer carries one', async () => {
    const source_url = 'https://github.com/align/cli/commit/abc1234def';
    const title = 'feat(auth): switch to JWT for stateless sessions';
    await client.ingestBatch([{ raw_text: RAW, title, source_url, platform: 'git' }]);
    const { snapshots } = await client.ingestBatch([{
      raw_text: 'feat(auth): switch to JWT for stateless sessions\n\nReworded, refs gone.',
      title, source_url, platform: 'git',
    }]);
    const d = await client.getDecision(snapshots[0].id);
    expect(d.external_references).toEqual([]);
  });

  it('does not record a captured URL as a reference to itself', async () => {
    const url = 'https://acme.atlassian.net/browse/PAY-31';
    const result = await client.captureDecision(url);
    const d = await client.getDecision(result.id);
    expect(d.external_references).toEqual([]);
  });

  // Review finding (2026-09-01): WHATWG href normalization (default-port stripping,
  // case folding) made the literal-equality self-URL filter leak - the captured URL
  // came back as its own "gap".
  it('does not self-reference when the captured URL normalizes differently', async () => {
    const withPort = await client.captureDecision('https://acme.atlassian.net:443/browse/PAY-31');
    expect((await client.getDecision(withPort.id)).external_references).toEqual([]);

    const upperScheme = await client.captureDecision('HTTPS://ACME.atlassian.net/browse/PAY-32');
    expect((await client.getDecision(upperScheme.id)).external_references).toEqual([]);
  });

  it('returns an empty list for a decision whose text carries no refs', async () => {
    const { snapshots } = await client.ingestBatch([{
      raw_text: 'Switch database from Postgres to CockroachDB',
      title: 'Switch database from Postgres to CockroachDB',
      source_url: 'https://github.com/align/cli/commit/eee9999fff',
      platform: 'git',
    }]);
    const d = await client.getDecision(snapshots[0].id);
    expect(d.external_references).toEqual([]);
  });
});
