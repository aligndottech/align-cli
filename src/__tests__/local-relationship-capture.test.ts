// ALI-1065: local-embedded typed a relationship only at check-time (checkAlignment),
// and even there the typed verdict was never persisted - decision_links only ever held
// an untyped `relates` cosine edge (see local-similarity-not-conflict.test.ts, ALI-503),
// so align_ask/align_search could return a decision that had actually been superseded
// with no way to know.
//
// This covers the capture-time half: ingestOne now classifies the high-confidence tier
// (bounded, budgeted, gated on a configured provider) and writes a typed edge instead of
// the untyped one; the read side (searchDecisions/listDecisions) now reports it in the
// SAME wire shape the cloud gateway already uses, so nothing downstream needs to change
// to surface it to an agent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../lib/local-embeddings.js", () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn(),
  EMBEDDING_MODEL_ID: "Xenova/all-MiniLM-L6-v2",
}));

vi.mock("../lib/local-relationship-classifier.js", () => ({
  classifyRelationship: vi.fn(),
}));

vi.mock("../lib/local-llm.js", () => ({
  hasConfiguredProvider: vi.fn(),
  noProviderHintInline: vi.fn().mockReturnValue(""),
  RECOMMENDED_OLLAMA_PULL: "llama3.2",
}));

import { createLocalDb } from "../lib/local-db.js";
import { cosineSimilarity } from "../lib/local-embeddings.js";
import { classifyRelationship } from "../lib/local-relationship-classifier.js";
import { hasConfiguredProvider } from "../lib/local-llm.js";
import { createLocalGatewayClient } from "../lib/local-gateway-client.js";
import { localValueRollup } from "../lib/value-rollup.js";

function tmpDbPath(name: string): string {
  return path.join(
    os.tmpdir(),
    `align-1065-${name}-${Date.now()}-${Math.trunc(performance.now())}.db`,
  );
}

function cleanup(dbPath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = `${dbPath}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe("ALI-1065 capture-time classification: budget and gating", () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = tmpDbPath("budget");
    client = createLocalGatewayClient(dbPath);
    // Above SIMILARITY_THRESHOLD (0.65), so the high-confidence tier is actually reached.
    vi.mocked(cosineSimilarity).mockReturnValue(0.8);
    vi.mocked(classifyRelationship).mockReset();
    vi.mocked(hasConfiguredProvider).mockReset();
  });

  afterEach(() => {
    client.close();
    cleanup(dbPath);
  });

  it("with no provider configured: zero classifier calls, falls back to untyped relates", async () => {
    vi.mocked(hasConfiguredProvider).mockReturnValue(false);

    await client.captureDecision("Use Postgres for the queue", "cli");
    await client.captureDecision("Use Redis for the queue", "cli");

    expect(classifyRelationship).not.toHaveBeenCalled();
    const db = createLocalDb(dbPath);
    const links = db.listLinks();
    db.close();
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.relation === "relates")).toBe(true);
  });

  it("caps classification at CAPTURE_CLASSIFY_TOP_K (3) even with more high-confidence candidates", async () => {
    vi.mocked(hasConfiguredProvider).mockReturnValue(true);
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: false,
      reason: "classifier_unparseable",
    });

    for (let i = 0; i < 5; i++) {
      await client.captureDecision(`Seed decision ${i}`, "cli");
    }
    vi.mocked(classifyRelationship).mockClear();
    await client.captureDecision(
      "A sixth decision, similar to all five seeds",
      "cli",
    );

    expect(classifyRelationship).toHaveBeenCalledTimes(3);
  });
});

describe("ALI-1065 capture-time classification: writes a typed edge, correct direction", () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = tmpDbPath("typed");
    client = createLocalGatewayClient(dbPath);
    vi.mocked(cosineSimilarity).mockReturnValue(0.8);
    vi.mocked(hasConfiguredProvider).mockReset().mockReturnValue(true);
    vi.mocked(classifyRelationship).mockReset();
  });

  afterEach(() => {
    client.close();
    cleanup(dbPath);
  });

  it("a classified supersedes writes ONE typed edge, the new decision as source (the superseder)", async () => {
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: true,
      relationship: { type: "supersedes", confidence: 0.9 },
    });

    const existing = await client.captureDecision(
      "Use Postgres for the queue",
      "cli",
    );
    const fresh = await client.captureDecision(
      "Use Redis for the queue, replacing Postgres",
      "cli",
    );

    const db = createLocalDb(dbPath);
    const links = db.listLinks({ decisionId: fresh.id });
    db.close();

    // ONE edge for the pair, not a cosine `relates` row AND a typed `supersedes` row.
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceId: fresh.id,
      targetId: existing.id,
      relation: "supersedes",
      confidence: 0.9,
    });
  });

  it("the classifier is called with the EXISTING decision as subject A, the new capture as candidate B", async () => {
    // The prompt is "how does B relate to A ... use supersedes when B replaces A" -
    // getting this order backwards would silently invert every supersession edge.
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: true,
      relationship: { type: "relates", confidence: 0.5 },
    });

    await client.captureDecision("Use Postgres for the queue", "cli");
    await client.captureDecision("Use Redis for the queue", "cli");

    expect(classifyRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Postgres") }),
      expect.objectContaining({ title: expect.stringContaining("Redis") }),
    );
  });

  it("a classified non-supersedes type still replaces the cosine relates edge with the typed one", async () => {
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: true,
      relationship: { type: "duplicates", confidence: 0.95 },
    });

    await client.captureDecision("Adopt gRPC for service calls", "cli");
    const b = await client.captureDecision(
      "gRPC is the standard for service to service",
      "cli",
    );

    const db = createLocalDb(dbPath);
    const links = db.listLinks({ decisionId: b.id });
    db.close();

    expect(links).toHaveLength(1);
    expect(links[0]?.relation).toBe("duplicates");
  });
});

describe("ALI-1065 capture-time classification: failure fallback never blocks capture", () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = tmpDbPath("fallback");
    client = createLocalGatewayClient(dbPath);
    vi.mocked(cosineSimilarity).mockReturnValue(0.8);
    vi.mocked(hasConfiguredProvider).mockReset().mockReturnValue(true);
    vi.mocked(classifyRelationship).mockReset();
  });

  afterEach(() => {
    client.close();
    cleanup(dbPath);
  });

  it("a classifier_error falls back to the untyped relates edge; capture still succeeds", async () => {
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: false,
      reason: "classifier_error",
    });

    const existing = await client.captureDecision(
      "Use Postgres for the queue",
      "cli",
    );
    const fresh = await client.captureDecision(
      "Use Redis for the queue",
      "cli",
    );

    expect(fresh.id).toBeTruthy();

    const db = createLocalDb(dbPath);
    const links = db.listLinks({ decisionId: fresh.id });
    db.close();
    expect(links[0]).toMatchObject({
      relation: "relates",
      targetId: existing.id,
    });
  });

  it("a provider_stopped failure short-circuits remaining candidates in THIS capture - they stay untyped", async () => {
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: true,
      relationship: { type: "supersedes", confidence: 0.9 },
    });
    for (let i = 0; i < 3; i++) {
      await client.captureDecision(`Seed decision ${i}`, "cli");
    }

    vi.mocked(classifyRelationship).mockClear();
    // Every call after this one would report ok:true (the persistent mock above) if the
    // chain did NOT stop - so a call count of 1 is only possible if the stop worked.
    vi.mocked(classifyRelationship).mockResolvedValueOnce({
      ok: false,
      reason: "classifier_error",
      failure: {
        kind: "provider_stopped",
        provider: "anthropic",
        model: "claude",
        detail: "429",
      },
    });

    await client.captureDecision(
      "A fourth decision, similar to all three seeds",
      "cli",
    );

    expect(classifyRelationship).toHaveBeenCalledTimes(1);
  });
});

describe("ALI-1065 read path: searchDecisions/listDecisions report real status", () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = tmpDbPath("read");
    client = createLocalGatewayClient(dbPath);
    // No classification noise on these captures - the status comes from a directly
    // inserted edge, mirroring local-similarity-not-conflict.test.ts's positive control.
    vi.mocked(hasConfiguredProvider).mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    client.close();
    cleanup(dbPath);
  });

  it("a decision with a supersedes edge targeting it reports status: superseded + successor", async () => {
    const old = await client.captureDecision(
      "Use Postgres for the queue",
      "cli",
    );
    const fresh = await client.captureDecision(
      "Use Redis for the queue",
      "cli",
    );

    const db = createLocalDb(dbPath);
    db.replaceLink({
      sourceId: fresh.id,
      targetId: old.id,
      relation: "supersedes",
      confidence: 0.9,
    });
    db.close();

    const list = await client.listDecisions({ all: true });
    const oldRow = list.find((d) => d.id === old.id);
    expect(oldRow).toMatchObject({
      status: "superseded",
      successor: expect.objectContaining({
        id: fresh.id,
        relation: "supersedes",
      }),
    });

    const results = await client.searchDecisions("queue", 10, undefined, {
      all: true,
    });
    const oldResult = results.results.find((r) => r.id === old.id);
    expect(oldResult).toMatchObject({ status: "superseded" });
  });

  it("a decision with no supersedes/contradicts edge reports no status field at all (ALI-1063 contract)", async () => {
    const only = await client.captureDecision("Adopt gRPC", "cli");

    const list = await client.listDecisions({ all: true });
    const row = list.find((d) => d.id === only.id);
    expect(row).not.toHaveProperty("status");
  });

  it("a contradicts edge reports status: conflicted + conflicts_with, taking precedence over supersession", async () => {
    const a = await client.captureDecision("Use Postgres for the queue", "cli");
    const b = await client.captureDecision("Use Redis for the queue", "cli");

    const db = createLocalDb(dbPath);
    db.replaceLink({
      sourceId: b.id,
      targetId: a.id,
      relation: "contradicts",
      confidence: 0.7,
    });
    db.close();

    const list = await client.listDecisions({ all: true });
    const rowA = list.find((d) => d.id === a.id);
    expect(rowA).toMatchObject({
      status: "conflicted",
      conflicts_with: expect.objectContaining({
        id: b.id,
        relation: "contradicts",
      }),
    });
  });

  it('listDecisions({status: "active"}) excludes a superseded decision, includes active ones', async () => {
    const old = await client.captureDecision(
      "Use Postgres for the queue",
      "cli",
    );
    const fresh = await client.captureDecision(
      "Use Redis for the queue",
      "cli",
    );
    const unrelated = await client.captureDecision("Adopt gRPC", "cli");

    const db = createLocalDb(dbPath);
    db.replaceLink({
      sourceId: fresh.id,
      targetId: old.id,
      relation: "supersedes",
      confidence: 0.9,
    });
    db.close();

    const active = await client.listDecisions({ all: true, status: "active" });
    expect(active.some((d) => d.id === old.id)).toBe(false);
    expect(active.some((d) => d.id === fresh.id)).toBe(true);
    expect(active.some((d) => d.id === unrelated.id)).toBe(true);
  });

  it("listDecisions with no status param returns everything, unchanged (back-compat)", async () => {
    const old = await client.captureDecision(
      "Use Postgres for the queue",
      "cli",
    );
    const fresh = await client.captureDecision(
      "Use Redis for the queue",
      "cli",
    );
    const db = createLocalDb(dbPath);
    db.replaceLink({
      sourceId: fresh.id,
      targetId: old.id,
      relation: "supersedes",
      confidence: 0.9,
    });
    db.close();

    const all = await client.listDecisions({ all: true });
    expect(all.some((d) => d.id === old.id)).toBe(true);
  });
});

describe("ALI-1065 local status rollup counts partially_supersedes alongside supersedes", () => {
  it("supersessions sums both relation types", () => {
    const db = createLocalDb(":memory:");
    const a = db.insertDecision({
      title: "A",
      summary: "",
      sourceUrl: null,
      platform: "cli",
    });
    const b = db.insertDecision({
      title: "B",
      summary: "",
      sourceUrl: null,
      platform: "cli",
    });
    const c = db.insertDecision({
      title: "C",
      summary: "",
      sourceUrl: null,
      platform: "cli",
    });
    db.insertLink({
      sourceId: a,
      targetId: b,
      relation: "supersedes",
      confidence: 1,
    });
    db.insertLink({
      sourceId: a,
      targetId: c,
      relation: "partially_supersedes",
      confidence: 1,
    });

    const out = localValueRollup(db);
    db.close();

    expect(out.supersessions).toBe(2);
  });
});
