import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Every vector is identical, so every pair clears SIMILARITY_THRESHOLD: a sync that classified would call the model for each.
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.99),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
const chat = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/local-llm.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasConfiguredProvider: () => true,
  callChatDetailed: async () => { chat.calls += 1; return { ok: false, failure: { kind: 'provider_stopped' } }; },
}));

import { runSync } from '../lib/sync/run-all.js';
import { type Harness, harness, pr } from './helpers/sync-env.js';

/**
 * L5 (journey 3, Decision 1): background sync, `align sync` and the re-link queue make ZERO LLM calls,
 * with a provider configured and every pair a near-duplicate. A positive control proves the counting stub is wired:
 * the explicit-capture path (no classify:false) DOES call it.
 */
vi.setConfig({ testTimeout: 60_000 });
let h: Harness;
beforeEach(() => { h = harness(); chat.calls = 0; });
afterEach(() => h.cleanup());

describe('a sync never spends the person\'s model', () => {
  it('positive control: an explicit capture-style ingest of near-duplicates calls the model', async () => {
    await h.env.client.ingestBatch([
      { source_url: 'https://github.com/o/r/pull/1', platform: 'github', title: 'A', raw_text: 'Use a queue' },
      { source_url: 'https://github.com/o/r/pull/2', platform: 'github', title: 'B', raw_text: 'Use a queue' },
    ], { keyed: true });
    expect(chat.calls).toBeGreaterThan(0);
  });

  it('five near-duplicate items through a full sync, then the re-link of all of them: 0 calls', async () => {
    h.script({ items: [1, 2, 3, 4, 5].map((n) => pr(n, `2026-10-0${n}T00:00:00.000Z`)) });
    await runSync(['github'], h.env, { trigger: 'background' });
    const db = new DatabaseSync(h.dbPath);
    db.exec('UPDATE decisions SET enriched_at = NULL; DELETE FROM decision_links');
    db.close();
    h.script({ items: [] });
    const r = await runSync(['github', 'slack'], h.env, { trigger: 'cli' });
    expect(r.relink?.linked).toBe(5);
    expect(chat.calls).toBe(0);
    const links = new DatabaseSync(h.dbPath);
    try {
      const rel = links.prepare('SELECT DISTINCT relation FROM decision_links').all() as Array<{ relation: string }>;
      expect(rel).toEqual([{ relation: 'relates' }]); // only the free kind
    } finally { links.close(); }
  });
});
