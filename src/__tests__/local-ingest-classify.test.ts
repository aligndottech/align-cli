// L1 (local capture time-window sync): background and connector ingest must not spend the
// user's money. ingestOne classifies up to CAPTURE_CLASSIFY_TOP_K candidates per item whenever
// a provider key is exported, so a connector import of N items was up to 3N paid LLM calls.
// `classify: false` turns that block off even with a key set; `classify: true` keeps it.
//
// The provider is real (local-llm + the real classifier), and only the network is doubled:
// a counting fetch that answers the Anthropic endpoint. So "zero calls" here means zero
// requests left the process, not that a mock of our own code was skipped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  // Every item embeds to the same vector and every pair scores 0.8, above
  // SIMILARITY_THRESHOLD (0.65), so each item after the first has classifiable candidates.
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.8),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { PROVIDER_ENV_VARS } from '../lib/llm-providers.js';
import { setSavedLlmSource } from '../lib/local-llm.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function countingProvider() {
  const calls = { count: 0 };
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
    const url = String(u);
    if (url.startsWith(ANTHROPIC_URL)) {
      calls.count++;
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: '{"type":"relates","confidence":0.9,"explanation":"x"}' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Nothing else is reachable: an Ollama probe or any other provider fails.
    throw new Error(`ECONNREFUSED ${url}`);
  }));
  return calls;
}

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    source_url: `https://github.com/o/r/pull/${i + 1}`,
    platform: 'github',
    title: `Use Postgres for the queue, take ${i}`,
    raw_text: `Use Postgres for the queue, take ${i}`,
  }));
}

describe('ingestBatch classify option', () => {
  let scratch: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    for (const k of PROVIDER_ENV_VARS) vi.stubEnv(k, undefined);
    vi.stubEnv('OLLAMA_HOST', undefined);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l1-classify-'));
    vi.stubEnv('HOME', scratch);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(scratch, '.config'));
    setSavedLlmSource(() => ({ keys: {} }));
    client = createLocalGatewayClient(path.join(scratch, 'local.db'));
  });

  afterEach(() => {
    client.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('makes zero classifier calls with classify:false even when a key is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'x'.repeat(40));
    const calls = countingProvider();
    await client.ingestBatch(items(20), { classify: false });
    expect(calls.count).toBe(0);
  });

  it('still classifies when asked: classify:true with the same key and items makes calls', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'x'.repeat(40));
    const calls = countingProvider();
    await client.ingestBatch(items(20), { classify: true });
    expect(calls.count).toBeGreaterThan(0);
  });
});
