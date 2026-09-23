/**
 * ALI-1066/ALI-1092 established the wire contract (`successor`/`conflicts_with`,
 * absent-vs-null) for the CLOUD half. ALI-1065 gives local-embedded a real writer of
 * `decision_links` typed edges (capture-time classification) and a real reader
 * (`relationFieldsFor` in local-gateway-client.ts), so this file's claim flips: local
 * `align_ask` now DOES surface a real `conflicts_with`/`successor` when a genuine typed
 * edge backs it, through the SAME `withDecisionRelationContract` pass-through the cloud
 * path uses - no new MCP-side code needed to carry the fields once local emits them.
 *
 * This used to assert the opposite (local never reads decision_links at all). That was
 * true before ALI-1065 and is the defect this ticket exists to fix - see the ticket and
 * `local-relationship-capture.test.ts` for the capture-time writer this reader depends
 * on. Kept as an MCP-level test, not just a unit test on searchDecisions, because the
 * thing worth proving is that the field survives `createCallToolHandler`'s real
 * serialization path end to end - a unit test on the client alone cannot show that.
 *
 * Positive controls stay: the search really returned the seeded decision, and a real
 * `conflicts_with` link really is on disk, under that relation, before the search runs.
 * Without both, "the field appeared" would be unfalsifiable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../lib/usage-telemetry.js", () => ({ recordFunnelStage }));

vi.mock("../lib/local-embeddings.js", () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  // Above every retrieval floor, so the seeded rows really do come back.
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
  EMBEDDING_MODEL_ID: "Xenova/all-MiniLM-L6-v2",
}));
vi.mock("../lib/local-relationship-classifier.js", () => ({
  classifyRelationship: vi
    .fn()
    .mockResolvedValue({ ok: false, reason: "no_llm_key" }),
  RELATIONSHIP_TYPES: ["relates_to"],
}));

import { createLocalDb } from "../lib/local-db.js";
import { createLocalGatewayClient } from "../lib/local-gateway-client.js";
import { createCallToolHandler, type dispatchTool } from "../commands/mcp.js";
import type { EnvironmentConfig } from "../lib/config.js";

type Client = Parameters<typeof dispatchTool>[2];
const local: EnvironmentConfig = {
  gatewayUrl: "",
  authToken: null,
  tenantId: null,
  mode: "local-embedded",
};

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ali1092-local-"));
  dbPath = path.join(dir, "graph.db");
});
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("local-embedded search reports a real conflicts_with edge (ALI-1065)", () => {
  it("a genuine conflicts_with edge on disk reaches align_ask, on the decision it targets", async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);

    const { snapshots } = await client.ingestBatch([
      {
        raw_text: "We will publish readOnlyHint annotations on all MCP tools.",
        title: "Publish readOnlyHint annotations",
        platform: "git",
      },
      {
        raw_text: "We will allowlist 36 read-only MCP tools in settings.json.",
        title: "Allowlist 36 read-only MCP tools",
        platform: "git",
      },
    ]);
    expect(snapshots, "seed produced no snapshots").toHaveLength(2);
    const [a, b] = snapshots as Array<{ id: string }>;

    const db = createLocalDb(dbPath);
    opened.push(db as unknown as { close(): void });
    db.insertLink({
      sourceId: a!.id,
      targetId: b!.id,
      relation: "conflicts_with",
      confidence: 0.9,
    });
    // Positive control on the write itself, read back as the local graph actually stores it.
    const stored = db.listLinks({ decisionId: a!.id });
    expect(stored.length, "the link write landed nothing").toBeGreaterThan(0);
    expect(
      stored.map((l) => l.relation),
      "the conflict edge is not on disk",
    ).toContain("conflicts_with");

    const handler = createCallToolHandler(client as unknown as Client, local);
    const out = await handler({
      params: {
        name: "align_ask",
        arguments: { question: "readOnlyHint annotations on MCP tools" },
      },
    });
    const text = out.content[0]!.text;
    const rows = (
      JSON.parse(text) as { results: Array<Record<string, unknown>> }
    ).results;

    // Positive control: the search really answered, so the assertions below are observations.
    expect(
      rows.length,
      "local search returned nothing - the checks below would be vacuous",
    ).toBeGreaterThan(0);
    const rowA = rows.find((r) => r["id"] === a!.id);
    expect(
      rowA,
      "the decision carrying the edge did not come back at all",
    ).toBeTruthy();
    expect(rowA).toMatchObject({
      status: "conflicted",
      conflicts_with: {
        id: b!.id,
        title: "Allowlist 36 read-only MCP tools",
        relation: "conflicts_with",
      },
    });
    // A conflict is symmetric by nature (unlike supersession, which is asymmetric - only
    // the superseded decision reports being replaced): B is the other end of the SAME edge,
    // so it reports the conflict too, pointing back at A. relationFieldsFor does not direct
    // conflicts_with the way it directs successor, and this is that on purpose, not a leak.
    const rowB = rows.find((r) => r["id"] === b!.id);
    expect(rowB).toMatchObject({
      status: "conflicted",
      conflicts_with: {
        id: a!.id,
        title: "Publish readOnlyHint annotations",
        relation: "conflicts_with",
      },
    });
  });
});
