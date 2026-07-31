import type { LocalDb } from './local-db.js';

export interface DemoDecision {
  platform: string;
  title: string;
  summary: string;
  sourceUrl: string | null;
}

export interface DemoLink {
  /** index into DEMO_DECISIONS */
  from: number;
  to: number;
  relation: string;
}

// A small, curated, cross-tool sample graph (Slack + GitHub) of GENERIC technical
// decisions - safe to publish in this OSS repo. The hero (index 0) is the
// synchronous-gRPC decision that the demo's beat 1 retrieves and whose
// contradiction (DEMO_CONTRADICTION) drives beat 2. The local `decisions` schema
// has no author column, so each summary carries its own "who decided it".
export const DEMO_DECISIONS: DemoDecision[] = [
  {
    platform: 'slack',
    title: 'Use synchronous gRPC for service-to-service calls',
    summary:
      'Decided in #checkout-squad by Priya Nair (Staff Eng) on 2026-06-12. Services communicate over synchronous gRPC, not an async event bus. Rationale: strongly-typed contracts, built-in backpressure, and simple request/response tracing. We explicitly rejected an async event bus because debugging cross-service causality through a broker was too costly for our team size.',
    sourceUrl: 'https://acme.slack.com/archives/C0CHECKOUT/p1749727200000000',
  },
  {
    platform: 'github',
    title: 'Adopt a shared gRPC health-check and deadline convention',
    summary:
      'PR #214, approved by Marcus Lee. Every gRPC service exposes the standard grpc.health.v1 Health service and sets a 2s client deadline. This refines the synchronous-gRPC service-communication decision.',
    sourceUrl: 'https://github.com/acme/platform/pull/214',
  },
  {
    platform: 'github',
    title: 'Standardize on PostgreSQL 16 for primary datastores',
    summary:
      'PR #180, approved by Dana Ortiz. New services use PostgreSQL 16 as their primary datastore; no new MySQL. Rationale: one operational surface, logical replication, and JSONB for semi-structured data.',
    sourceUrl: 'https://github.com/acme/platform/pull/180',
  },
  {
    platform: 'slack',
    title: 'Frontend state via TanStack Query, not Redux',
    summary:
      'Decided in #web-guild by Sam Cho on 2026-05-02. Server state is managed through TanStack Query; Redux is reserved for genuine client-only state. Rationale: most of what we called "global state" was really cached server data.',
    sourceUrl: 'https://acme.slack.com/archives/C0WEBGUILD/p1746180000000000',
  },
];

// Curated links only. There is deliberately NO conflicts_with link here: the
// money-moment conflict is the LIVE change the agent proposes at demo time,
// classified by the LLM, not pre-baked into the graph (which would make beat 2 a
// fixture rather than a real detection).
export const DEMO_LINKS: DemoLink[] = [
  { from: 1, to: 0, relation: 'refines' }, // health-check convention refines the gRPC decision
];

// The change the agent proposes in beat 2; it contradicts DEMO_DECISIONS[0]. Kept
// here so the runbook and any harness share one canonical wording.
export const DEMO_CONTRADICTION =
  'Switch the checkout service from synchronous gRPC to an async Kafka event bus for service-to-service communication.';

/**
 * Populate a local decision graph with the curated demo sample: insert each
 * decision, embed it (title + summary) so semantic search can retrieve it, then
 * add the curated links. `embed` is injected so callers pass the real on-device
 * model while tests pass a fake. Returns the inserted ids in DEMO_DECISIONS order.
 */
export async function seedDemoGraph(
  db: LocalDb,
  embed: (text: string) => Promise<Float32Array>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const d of DEMO_DECISIONS) {
    const id = db.insertDecision({
      title: d.title,
      summary: d.summary,
      sourceUrl: d.sourceUrl,
      platform: d.platform,
    });
    db.setEmbedding(id, await embed(`${d.title}. ${d.summary}`));
    ids.push(id);
  }
  for (const link of DEMO_LINKS) {
    db.insertLink({
      sourceId: ids[link.from]!,
      targetId: ids[link.to]!,
      relation: link.relation,
      confidence: 1.0,
    });
  }
  return ids;
}
