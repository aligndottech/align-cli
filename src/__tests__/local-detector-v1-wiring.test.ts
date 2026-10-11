// P3 (shared detector): ALIGN_DETECTOR picks the local detector for `align check` and the capture
// link pass. The classifier, prompt, parser and resolver are real; only the network is doubled
// (a fetch that answers the Anthropic endpoint and records each request).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.8),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { PROVIDER_ENV_VARS } from '../lib/llm-providers.js';
import { setSavedLlmSource } from '../lib/local-llm.js';
import { V0_SYSTEM_PROMPT } from '../lib/local-relationship-classifier.js';
import { buildV1SystemPrompt } from '../detector/relationship-prompt.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const V1_CONFLICT = JSON.stringify({ relationships: { similar: [
  { decision_ref: 1, type: 'incompatible', confidence: 0.9, reasons: ['opposed'], evidence: { new_quote: 'use SQS', existing_quote: 'use Postgres' }, replaced: null },
] } });
const V0_RELATES = '{"type":"relates","confidence":0.9,"reason":"x"}';

interface Sent { system: string; user: string }
function provider(answer: string) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: unknown, init?: { body?: string }) => {
    const url = String(u);
    if (!url.startsWith(ANTHROPIC_URL)) throw new Error(`ECONNREFUSED ${url}`);
    const body = JSON.parse(init?.body ?? '{}') as { system?: unknown; messages?: Array<{ content: unknown }> };
    sent.push({ system: JSON.stringify(body.system), user: JSON.stringify(body.messages?.[0]?.content) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: answer }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return sent;
}

const items = (n: number) => Array.from({ length: n }, (_, i) => ({
  source_url: `https://github.com/o/r/pull/${i + 1}`, platform: 'github',
  title: `Use Postgres for the queue, take ${i}`, raw_text: `Use Postgres for the queue, take ${i}`,
}));

let scratch: string;
let dbPath: string;
let client: ReturnType<typeof createLocalGatewayClient>;
beforeEach(() => {
  for (const k of PROVIDER_ENV_VARS) vi.stubEnv(k, undefined);
  vi.stubEnv('OLLAMA_HOST', undefined);
  vi.stubEnv('ALIGN_DETECTOR', undefined);
  vi.stubEnv('ALIGN_CLASSIFIER_MAX_TOKENS', undefined);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'align-detector-v1-'));
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(scratch, '.config'));
  vi.stubEnv('ANTHROPIC_API_KEY', 'x'.repeat(40));
  setSavedLlmSource(() => ({ keys: {} }));
  dbPath = path.join(scratch, 'local.db');
  client = createLocalGatewayClient(dbPath);
});
afterEach(() => {
  client.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Seeds under an explicit v0 (so the seed's links are stamped v0), then leaves ALIGN_DETECTOR unset again. */
async function seed(n: number): Promise<void> {
  vi.stubEnv('ALIGN_DETECTOR', 'v0');
  provider(V0_RELATES);
  await client.ingestBatch(items(n), { classify: false });
  vi.stubEnv('ALIGN_DETECTOR', undefined);
}

describe('align check under ALIGN_DETECTOR', () => {
  it('v1: 3 candidates -> ONE call listing all 3, and an incompatible answer becomes a conflict', async () => {
    await seed(3);
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    const sent = provider(V1_CONFLICT);
    const result = await client.checkAlignment('switch the queue to SQS', undefined, { title: 'Use SQS for the queue' });
    expect(sent).toHaveLength(1);
    for (const i of [0, 1, 2]) expect(sent[0]!.user).toContain(`Use Postgres for the queue, take ${i}`);
    expect(sent[0]!.user).toContain('SIMILAR DECISIONS:');
    expect(result.status).toBe('conflicting');
    expect(result.conflicts).toHaveLength(1);
  });

  it('v1: 1 candidate -> still one call', async () => {
    await seed(1);
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    const sent = provider(JSON.stringify({ similar: [] }));
    const result = await client.checkAlignment('switch the queue to SQS');
    expect(sent).toHaveLength(1);
    expect(result.status).toBe('aligned');
  });

  it('v1: an unparseable answer is unknown, never aligned', async () => {
    await seed(2);
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    provider('no json here');
    expect((await client.checkAlignment('switch the queue to SQS')).status).toBe('unknown');
  });

  it('unset: v1 (the default), one call over every candidate, with the v1 system prompt', async () => {
    await seed(3);
    const sent = provider(V1_CONFLICT);
    const result = await client.checkAlignment('switch the queue to SQS');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.system).toBe(JSON.stringify(buildV1SystemPrompt()));
    expect(result.status).toBe('conflicting');
  });

  it('explicit v1: one call over every candidate, with the v1 system prompt', async () => {
    await seed(3);
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    const sent = provider(V1_CONFLICT);
    const result = await client.checkAlignment('switch the queue to SQS');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.system).toBe(JSON.stringify(buildV1SystemPrompt()));
    expect(result.status).toBe('conflicting');
  });

  it('explicit v0: still selectable, one call per candidate, with the v0 system prompt', async () => {
    await seed(3);
    vi.stubEnv('ALIGN_DETECTOR', 'v0');
    const sent = provider(V0_RELATES);
    await client.checkAlignment('switch the queue to SQS');
    expect(sent).toHaveLength(3);
    for (const s of sent) expect(s.system).toBe(JSON.stringify(V0_SYSTEM_PROMPT));
  });

  it('an unknown ALIGN_DETECTOR fails naming the allowed values', async () => {
    await seed(1);
    vi.stubEnv('ALIGN_DETECTOR', 'v2');
    provider(V0_RELATES);
    await expect(client.checkAlignment('x')).rejects.toThrow(/v0, v1/);
  });
});

describe('capture link pass under ALIGN_DETECTOR', () => {
  const linkVersions = () => {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare('SELECT relation, detector_version AS v FROM decision_links ORDER BY relation').all() as Array<{ relation: string; v: string }>;
    } finally { db.close(); }
  };

  it('v1: one call per captured item over all its candidates, links stamped v1', async () => {
    await seed(2);
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    const sent = provider(JSON.stringify({ similar: [{ decision_ref: 1, type: 'refines', confidence: 0.7 }] }));
    await client.ingestBatch([{ source_url: 'https://github.com/o/r/pull/99', platform: 'github', title: 'Queue retries', raw_text: 'Queue retries use backoff' }], { classify: true });
    expect(sent).toHaveLength(1);
    const v1Rows = linkVersions().filter((r) => r.v === 'v1');
    expect(v1Rows.map((r) => r.relation).sort()).toEqual(['refines', 'relates']);
  });

  it('explicit v1: one call, new links stamped v1', async () => {
    await seed(2);
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    const sent = provider(JSON.stringify({ similar: [{ decision_ref: 1, type: 'refines', confidence: 0.7 }] }));
    await client.ingestBatch([{ source_url: 'https://github.com/o/r/pull/99', platform: 'github', title: 'Queue retries', raw_text: 'Queue retries use backoff' }], { classify: true });
    expect(sent).toHaveLength(1);
    expect(linkVersions().filter((r) => r.v === 'v1').map((r) => r.relation).sort()).toEqual(['refines', 'relates']);
  });

  it('explicit v1: an edge no detector judged keeps the v0 stamp, so relink can still type it', async () => {
    await seed(1);
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    const sent = provider(JSON.stringify({ similar: [] }));
    await client.ingestBatch([{ source_url: 'https://github.com/o/r/pull/97', platform: 'github', title: 'Queue retries', raw_text: 'Queue retries use backoff' }], { classify: false });
    expect(sent).toHaveLength(0);
    const rows = linkVersions();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.relation === 'relates' && r.v === 'v0')).toBe(true);
  });

  it('unset (v1): a failed v1 call leaves the cosine edge stamped v0, never v1', async () => {
    await seed(1);
    provider('no json here');
    await client.ingestBatch([{ source_url: 'https://github.com/o/r/pull/96', platform: 'github', title: 'Queue retries', raw_text: 'Queue retries use backoff' }], { classify: true });
    const rows = linkVersions();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.v === 'v1')).toEqual([]);
  });

  it('explicit v0: pairwise, links stamped v0', async () => {
    await seed(2);
    vi.stubEnv('ALIGN_DETECTOR', 'v0');
    const sent = provider(V0_RELATES);
    await client.ingestBatch([{ source_url: 'https://github.com/o/r/pull/99', platform: 'github', title: 'Queue retries', raw_text: 'Queue retries use backoff' }], { classify: true });
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(linkVersions().every((r) => r.v === 'v0')).toBe(true);
  });

  it('F5 v1: a candidate another decision supersedes is shown RETIRED and gets no verdict edge', async () => {
    await seed(3);
    const raw = new DatabaseSync(dbPath);
    const ids = raw.prepare('SELECT id, title FROM decisions ORDER BY title').all() as Array<{ id: string; title: string }>;
    raw.prepare(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES ('s1', ?, ?, 'supersedes', 1)`).run(ids[2]!.id, ids[0]!.id);
    raw.close();
    vi.stubEnv('ALIGN_DETECTOR', 'v1');
    const ev = { new_quote: 'use SQS', existing_quote: 'use Postgres' };
    const sent = provider(JSON.stringify({ similar: [1, 2, 3, 4].map((n) => ({ decision_ref: n, type: 'incompatible', confidence: 0.9, evidence: ev, replaced: 'new' })) }));
    await client.ingestBatch([{ source_url: 'https://github.com/o/r/pull/98', platform: 'github', title: 'Queue on SQS', raw_text: 'Use SQS for the queue' }], { classify: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.user).toContain(`${ids[0]!.title} (similarity:`);
    expect(sent[0]!.user).toMatch(/\[RETIRED\]/);
    const db = new DatabaseSync(dbPath);
    try {
      const edges = db.prepare(`SELECT relation FROM decision_links WHERE detector_version = 'v1' AND (source_id = ? OR target_id = ?)`).all(ids[0]!.id, ids[0]!.id) as Array<{ relation: string }>;
      expect(edges.map((e) => e.relation)).not.toContain('conflicts_with');
      expect(edges.map((e) => e.relation)).not.toContain('supersedes');
      const others = db.prepare(`SELECT relation FROM decision_links WHERE detector_version = 'v1' AND relation = 'conflicts_with'`).all();
      expect(others.length).toBeGreaterThan(0);
    } finally { db.close(); }
  });
});
