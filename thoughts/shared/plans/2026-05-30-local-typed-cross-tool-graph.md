# Plan: Local typed cross-tool decision graph (solo dev)

## Decision (2026-05-30)
"Solo / local" mode = a personal developer connects their **own** tool accounts via **personal OAuth** (not the org/workspace-level Align app install) and gets a **cross-tool decision graph built locally** (SQLite). Relationships are **typed** via a **two-stage** approach.

Supersedes the interpretation in PR #20 (which routed solo → zero-cloud SQLite, git-only, no connectors, no typed relationships).

## Two-stage relationship typing (cost-aware)
1. **Candidate retrieval — local embeddings, free.** `findSimilar` narrows to the handful of decisions semantically near a subject. No API calls. Stored as untyped `relates_to` candidate edges on ingest, so **bulk import (git/connectors) stays $0**.
2. **Relationship typing — LLM, lazy + on-demand.** Only when the agent inspects edges (`align_check_alignment`, `align_get_related_decisions`) do we call an LLM (user's own key, Haiku) to assign the real taxonomy: `supersedes | conflicts_with | contradicts | duplicates | refines | implements | depends_on | relates_to`. Embeddings pre-filter → only ~1-5 pairs typed per query. No key → stays untyped `relates_to`, clearly labeled.

Why: embedding similarity ≠ relationship type (two "database" decisions score high whether they agree or conflict). Only an LLM reading both can type the edge.

## Phases
- **Phase 1 (this PR): typed-relationship classifier.** New `src/lib/local-relationship-classifier.ts`: `classifyRelationship(subjectA, candidateB) -> { type, confidence, reason } | null` (null = no key → untyped). Anthropic (Haiku) + OpenAI now; consolidate with `local-llm.ts` multi-provider later. TDD with mocked fetch.
- **Phase 2 (this PR): typed checkAlignment.** Local `checkAlignment(diff)` → embeddings find candidates → classify each vs the change → verdict `conflict | related | no_context` with typed edges + platform, so the agent surfaces "⚠️ conflicts with a Slack decision from March (supersedes)". Untyped fallback if no key.
- **Phase 3: personal-OAuth connectors → local graph.** Rework `align setup` solo path: offer connector multiselect (personal OAuth, reuse existing gateway `startCliOAuth` + client-side fetchers), but **ingest into the LOCAL client** (`ingestBatch`) instead of cloud. Data lands in the dev's local SQLite graph, never the org cloud tenant. Embeddings-only at ingest (free).
- **Phase 4: proactive + cross-tool MCP descriptions.** Rewrite `align_check_alignment` / `align_get_related_decisions` / `align_capture` descriptions so the agent calls them *before acting* and captures decisions from *any* tool.

## Notes
- Replace the crude "similarity ≥0.65 ⇒ conflicts_with" labeling in `ingestOne` — embeddings only assert *candidate* (`relates_to`); the LLM asserts the type.
- Personal OAuth: reuse existing per-connector OAuth; the privacy win is that data is stored locally, not in the shared org tenant.
- Cost: bulk import free; typing only what you inspect, with your key, on Haiku.
