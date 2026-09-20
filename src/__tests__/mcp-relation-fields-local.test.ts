/**
 * ALI-1066/ALI-1092, LOCAL half, asserted against the REAL local client and a real SQLite graph
 * rather than against a fake that returns whatever the test authors it to.
 *
 * The claim being pinned is a DEPLOYMENT-PARITY claim, so it has to be earned rather than
 * assumed: cloud, paid, self-host and true local SQLite behave the same WHERE THE DATA ALLOWS,
 * and here it does not. Local `searchDecisions` builds an explicit row literal out of the
 * `decisions` table and never reads `decision_links` at all, so there is no successor and no
 * counterpart for it to report. The rule the rest of this client already follows is "absent
 * beats fabricated", which is why a local row carries no `status` and no `decision_url` either.
 *
 * The first draft of this test justified the absence with "ALI-503 relabels every
 * `conflicts_with` edge to `relates`", and the test went RED and disproved it. That relabel is a
 * ONE-TIME `user_version < 1` migration repairing rows an old cosine writer minted - it is not an
 * invariant on `insertLink`, so an edge written today keeps its relation. Reading the writer
 * beats reading the sentence about the writer, and the surviving assertion is stronger for it:
 * a genuine `conflicts_with` row sits on disk and local search still reports nothing.
 *
 * So this suite asserts the ABSENCE, with positive controls beside it: the same search really
 * did return the seeded decision, and a `conflicts_with` link really is in the database, stored
 * under that relation, before the search ran. Without both, "neither field appeared" is
 * satisfied by a search that found nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  // Above every retrieval floor, so the seeded rows really do come back.
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { createCallToolHandler, type dispatchTool } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';

type Client = Parameters<typeof dispatchTool>[2];
const local: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'local-embedded' };

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali1092-local-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local-embedded search carries no relation fields', () => {
  it('omits successor and conflicts_with even with a conflict edge on disk', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);

    const { snapshots } = await client.ingestBatch([
      { raw_text: 'We will publish readOnlyHint annotations on all MCP tools.', title: 'Publish readOnlyHint annotations', platform: 'git' },
      { raw_text: 'We will allowlist 36 read-only MCP tools in settings.json.', title: 'Allowlist 36 read-only MCP tools', platform: 'git' },
    ]);
    expect(snapshots, 'seed produced no snapshots').toHaveLength(2);
    const [a, b] = snapshots as Array<{ id: string }>;

    // Write the edge the cloud graph would use to derive a counterpart. If the local client
    // could ever surface one, this is the row it would surface - so its absence downstream is
    // a statement about the local graph, not about an empty database.
    const db = createLocalDb(dbPath);
    opened.push(db as unknown as { close(): void });
    db.insertLink({ sourceId: a!.id, targetId: b!.id, relation: 'conflicts_with', confidence: 0.9 });
    // Positive control on the write itself, read back as the local graph actually stores it.
    // The relation SURVIVES (the ALI-503 relabel is a one-time `user_version < 1` repair, not a
    // rule on insert), so the absence asserted below is not an artefact of the row being
    // rewritten - local search simply never reads this table.
    const stored = db.listLinks({ decisionId: a!.id });
    expect(stored.length, 'the link write landed nothing').toBeGreaterThan(0);
    expect(stored.map((l) => l.relation), 'the conflict edge is not on disk').toContain('conflicts_with');

    const handler = createCallToolHandler(client as unknown as Client, local);
    const out = await handler({
      params: { name: 'align_ask', arguments: { question: 'readOnlyHint annotations on MCP tools' } },
    });
    const text = out.content[0]!.text;
    const rows = (JSON.parse(text) as { results: Array<Record<string, unknown>> }).results;

    // Positive control: the search really answered, so the absences below are observations.
    expect(rows.length, 'local search returned nothing - the absences below would be vacuous').toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('successor');
      expect(row).not.toHaveProperty('conflicts_with');
    }
    expect(text).not.toContain('successor');
    expect(text).not.toContain('conflicts_with');
  });
});
