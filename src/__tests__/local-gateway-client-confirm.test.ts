/**
 * ALI-808: `confirmSessionDecision` is the confirm-each importer's one write path - ingest
 * exactly like `ingestBatch` does (same `ingestOne`, so `platform: 'agent-session'` derives
 * `decider_kind: 'agent'` for free via ALI-831's deriveDeciderKind), then stamp confirmed_by
 * / confirmed_at via the new local-db.ts `markConfirmed`. Kept in its own file for the same
 * reason as local-db-confirm.test.ts: this is the one small addition to a file ALI-808 does
 * not otherwise own.
 *
 * Test List:
 * 1. stores the decision with platform 'agent-session' and decider_kind 'agent' (for free)
 * 2. stamps confirmed_by / confirmed_at on the same row
 * 3. uses the given source_url and title verbatim (the <agent>-session:// scheme, a
 *    question as the title) rather than the default input-slice/URL-hostname guess
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

describe('confirmSessionDecision', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-lgc-confirm-test-${Date.now()}.db`);
    client = createLocalGatewayClient(dbPath);
  });
  afterEach(() => {
    client.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('stores the decision as an agent claim - platform agent-session, decider_kind agent for free', async () => {
    const result = await client.confirmSessionDecision(
      { source_url: 'claude-code-session://s1/t1', raw_text: 'Fold the one-line fix into my PR', title: 'How do you want the fix handled?' },
      'tom@align.tech',
    );
    expect(result).toHaveProperty('id');
    const row = await client.getDecision(result.id);
    expect(row.platform).toBe('agent-session');
    expect(row.decider_kind).toBe('agent');
  });

  it('stamps confirmed_by and confirmed_at, returned from the call itself', async () => {
    const result = await client.confirmSessionDecision(
      { source_url: 'pi-session://s1/t1', raw_text: 'reject with 401', title: 'How should the handler fail?' },
      'tom@align.tech',
    );
    expect(result.confirmedBy).toBe('tom@align.tech');
    expect(result.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('uses the given source_url and title verbatim, not the default URL-hostname guess', async () => {
    const result = await client.confirmSessionDecision(
      { source_url: 'codex-session://sess-9/msg-2', raw_text: 'Decision: 3 retries.', title: 'Retry count for failed webhook deliveries' },
      'tom@align.tech',
    );
    expect(result.title).toBe('Retry count for failed webhook deliveries');
    const row = await client.getDecision(result.id);
    expect(row.source_url).toBe('codex-session://sess-9/msg-2');
  });
});
