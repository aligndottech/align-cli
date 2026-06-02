# Research: Git-repo-committed shared decision graph for the OSS CLI

Date: 2026-05-31
Author: Claude (harness /research)
Question: Can the open-source CLI support a `.align/`-committed, multi-developer shared decision graph (each dev commits their discovered decisions; the CLI detects cross-person conflicts / duplicates / consensus offline), without cannibalising the paid org-wide tier?

## Strategic framing (from the shared ChatGPT thread + product memory)

The boundary that keeps the OSS version *surprisingly powerful* while leaving a real moat:

- **OSS (committed git graph):** human-curated, repo-scoped decision sharing. Each dev's discovered decisions live as committed files; the CLI builds a graph and flags conflicts/duplicates/consensus across people - fully offline, developer-native.
- **Paid (cloud):** organisation-wide *continuous, authoritative* context - Slack threads, Jira tickets, meeting outcomes, approvals, supersession across 400 repos, agent activity. A repo cannot become the company brain at scale; nobody syncs all of that through `.align/`.

This matches the standing strategy (OSS CLI+MCP MIT, backend closed). The thread's key insight, which our code confirms: **the value is in the relationships/graph (network effect), not the raw decisions** - and continuous cross-tool ingestion is what a git folder structurally can't do. Current bigger risk is "free product not useful enough," so making OSS genuinely useful here is the right bet.

## What already exists (verified, align-cli)

Local mode is further along than expected - most building blocks exist:

- **Local graph store:** SQLite at `~/.config/align-cli/local.db` - tables `decisions`, `decision_embeddings` (384-dim), `decision_links(source_id, target_id, relation, confidence)`. [src/lib/local-db.ts](src/lib/local-db.ts), [src/lib/local-mode.ts](src/lib/local-mode.ts)
- **On-device relationship detection:** embeddings via Xenova `all-MiniLM-L6-v2` ([src/lib/local-embeddings.ts](src/lib/local-embeddings.ts)); cosine similarity candidate discovery (`CONFLICT_THRESHOLD 0.65`, `RELATES_THRESHOLD 0.45`) + optional LLM typing with the user's own API key ([src/lib/local-relationship-classifier.ts](src/lib/local-relationship-classifier.ts), taxonomy: supersedes/conflicts_with/contradicts/duplicates/refines/implements/depends_on/relates_to). Degrades gracefully to untyped edges with no key. [src/lib/local-gateway-client.ts](src/lib/local-gateway-client.ts)
- **Git import → decisions:** [src/commands/import/git.ts](src/commands/import/git.ts), [src/lib/git.ts](src/lib/git.ts).
- **MCP server** serves all 8 tools from the local graph in `local-embedded` mode. [src/commands/mcp.ts](src/commands/mcp.ts), [src/lib/gateway-client.ts](src/lib/gateway-client.ts)

## The gap

There is **no file-based decision format and no `.align/` concept** - storage is binary SQLite, per-machine, per-developer. A committed shared graph needs:

1. **Git-friendly decision files.** Export decisions to text (Markdown + YAML frontmatter) under `.align/<author>/<id>.md`: id, title, summary, source_url, platform, author, timestamp, and the decision body. Human-diffable, mergeable, reviewable in PRs.
2. **Content-addressed IDs for dedup.** Today IDs are random UUIDs (no cross-dev dedup). A committed graph needs deterministic IDs (hash of normalised content/source_url) so Bob and Thomas both capturing "use Stripe" collapse or are detected as duplicates.
3. **A build/merge step.** `align graph build` (or fold into local sync): read every `.align/**/*.md`, (re)embed, run conflict/dup/consensus detection across all authors, write a graph view. Reuses `local-embeddings.ts` + `local-relationship-classifier.ts` directly.
4. **Multi-author semantics.** "Alice: use Stripe / Sarah: use Adyen" → a `conflicts_with` across authors; "Thomas + Bob: Stripe" → consensus/duplicate. Store author attribution on edges; surface "emerging consensus" and "open conflict" in `align ask`/MCP.
5. **Embeddings: recompute vs commit.** Git versions binary BLOBs poorly. Recommend **recompute from title+summary at build time** (deterministic with a pinned model) rather than committing embeddings - keeps the repo clean and the graph reproducible. (This also ties into the determinism work: pin the model + deterministic ordering.)

## Feasibility & reuse

High. The taxonomy, local embeddings, local classifier, and MCP serving layer all already exist and run offline. The net-new surface is: a Markdown±frontmatter (de)serializer, content-addressed IDs, a `.align/` reader/writer, and a build/merge command. No backend, no cloud - pure CLI, fits the MIT OSS story.

## Risks / open questions (for /plan + sign-off)
- **Cannibalisation:** low, per the framing - repo-scoped manual sharing ≠ org-wide continuous ingestion. Keep multi-connector continuous sync, approvals/governance, cross-repo + Slack/Jira/meetings firmly paid.
- **Merge conflicts on the graph file:** avoid by committing only per-author *source* decision files (append-only, rarely conflict) and treating the built graph as a derived artifact (gitignored or built in CI), not a committed merge target.
- **Determinism:** the cross-person conflict/dup detection must be deterministic to be trustworthy in PRs - depends on the same fixes as the cloud determinism work (pinned embedding model, temp 0 + seed, stable ordering). Do that first / share the approach.
- **Scope of v1:** start with `.align/` export + `align graph build` + conflict/dup/consensus over committed files + MCP exposure. Defer richer consensus/voting.

## Recommendation
Worth doing as an OSS wedge feature. Sequence: (1) land relationship **determinism** first (shared dependency + trust), (2) then `/plan` the `.align/` committed graph (file format, content-addressed IDs, build/merge, multi-author edges), reusing the existing local embedding + classifier stack. Create an align-cli parent ticket; keep org-wide ingestion paid.
