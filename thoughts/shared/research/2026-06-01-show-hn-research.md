# Research: Show HN launch for Align CLI

Date: 2026-06-01. Purpose: ground the Show HN post in accurate product internals,
current align.tech messaging, and validated voice/positioning. Sources: code in
align-cli + align-stack (gateway/brain), align-frontend main `3a2cd3a`, and the Align
Outreach Tracker sheet (Positioning Lab, Discovery Patterns, 60-Day Wedge Test).

## How the product actually works (so the post survives HN scrutiny)

Decision extraction (brain, services/brain): an LLM call with structured JSON output.
Pulls title, summary, decisions, risks, owners/who, and a confidence score. Not a black
box; retries once on bad JSON, falls back to empty.

Relationship detection (the differentiator, but honest about it):
- Each decision is embedded. Cloud: pgvector, 1536-dim (OpenAI). Local: 384-dim MiniLM.
- Related decisions found by cosine similarity (vector search). Threshold ~0.65 to bother
  going further.
- A single LLM call then classifies the pair: supersedes / conflicts_with / contradicts /
  duplicates / refines / implements / depends_on / relates_to. Defaults to relates_to when
  unsure; deliberately conservative about calling something a conflict.
- Cloud `decision_links` stores a small relation set; brain analyses ~10-11 types and
  filters. Frontend whitepaper lists 11 types.
- HONEST FRAMING (internal): today it is embeddings + cosine + one LLM classification call.
  The bet is cross-tool extraction + typed conflict/supersession edges + wiring it into the
  agent loop, not a clever model.
- PUBLIC FRAMING (decided 2026-06-01): do NOT volunteer "there's no novel ML" in public posts.
  It anchors readers/competitors/enterprise buyers on "trivial vector DB" and contradicts the
  roadmap (bespoke models on hosted GPU nodes for enterprise). Describe local mode honestly
  (it is open source anyway: on-device embedding model + SQLite, framed as a privacy/free
  feature), keep hosted internals private, and say "the hosted side does the heavier
  cross-tool detection" (true today). Stay honest, just not self-deprecating. The moat is
  data + typed graph + in-loop workflow + future trained models, not the v1 algorithm.

checkAlignment (`/alignment/check`, what `align check` hits): embed the diff/query, vector
search, if top similarity < ~0.65 fast-return "aligned", else one LLM call (short timeout)
to extract conflicts. Status: no-context / aligned / conflicting. Severity: >=0.8 critical,
0.5-0.8 warning. Rate-limited per tenant. Fails open.

Local mode (align-cli, fully offline): SQLite (better-sqlite3, WAL) at
~/.config/align-cli/local.db with decisions / decision_embeddings / decision_links. Xenova
all-MiniLM-L6-v2 (384-dim) via @xenova/transformers, on-device. Cosine similarity for edges;
optional LLM typing only if the user has their own API key (Anthropic/OpenAI/etc), else the
edge stays untyped. `align ask` synthesis uses the user's own key or local Ollama, else
prints a ranked list. No Align cloud call anywhere in local mode.

MCP server: 8 tools (ask, search, capture, check_alignment, check_drift, get_impact,
get_conflicts, get_related_decisions). Works in both cloud and local. Server instructions
nudge the agent to check alignment before non-trivial changes (ALI-120).

Advisory hook (PR #47, what we just shipped): `align setup` writes a Claude Code PostToolUse
hook (matcher Write|Edit) -> `align check --advisory`. Always exits 0, 8s internal timeout,
fail-open; on conflict emits hookSpecificOutput.additionalContext JSON. Also writes a managed
CLAUDE.md block and .cursor/rules/align.md. Idempotent.

Read-only: every fetcher is GET/search only; personal OAuth tiers are read-only by scope
(write lives only in the team bot apps).

Three tiers, do not conflate (corrected 2026-06-01 by Tom):
- `align setup` default = personal CLOUD graph, FREE (synced, backed up, your own tenant).
  This is the default, NOT local.
- `align setup --local` = fully offline opt-in (SQLite + on-device MiniLM, no account).
- Team/Enterprise = PAID: shared org graph, governance, SSO.
CLI + MCP server are MIT in all cases. So "free vs paid" is single-user (cloud or local) vs
shared-team, NOT "local free vs cloud paid".

Read-only is CLI/PERSONAL ONLY. Every CLI fetcher is GET/search and personal OAuth tiers are
read-only by scope. The TEAM/paid product is NOT read-only: the org bot has write scopes
(Slack chat:write, Jira comments) and posts a decision summary back, but only into a thread a
person explicitly tags it in, never unprompted. Never claim the whole product is read-only;
scope the read-only claim to the CLI/personal tier.

Credibility facts safe to cite: CLI has 224 tests (verified). MIT. Local mode is real, not a
demo. Avoid citing inflated repo-wide test-file counts.

## align.tech current messaging (consistency anchors), main 3a2cd3a

Hero: "Your AI agents know the code. They don't know the company."
Sub: "ADRs catch the big calls. The hundreds of smaller ones, scattered across chat,
tickets, PRs and meetings, leave your agents blind to what still stands, what conflicts, and
why. Align makes them one graph you check before shipping."
Trust strip: "No passive monitoring / No message storage / Encrypted & isolated /
Self-hosted option."
Stat (rigorous version): "AI-generated code carries 1.7x more issues than human-written"
(CodeRabbit, Dec 2025, 470 PRs). Homepage rounds to "70% more". Use the 1.7x/CodeRabbit form
if citing at all; better to drop stats in an HN post.
Pricing: CLI free/MIT, no account; Team pilot pricing ("At 50+ engineers, 'just ask' stops
working"); Enterprise self-hosted/SSO/compliance.

## Voice + positioning (validated)

Hard rules (brand_voice.yaml + 60-Day Wedge Test + Outreach DM voice memory):
- NO em dashes. Spaced hyphen only. (Wedge Test: "em-dash-free".)
- British spelling. Founder voice, problem-first. Banned: decision drift, automatic capture,
  passive monitoring/surveillance, leverage, unlock, empower, seamless, cutting-edge,
  game-changer, revolutionary, "excited to share". Never name the employer.
- Tom's tics: "the thing that's been bugging me", "I'm trying to work out whether", "tell me
  what's rubbish", "a bit of a rabbit hole", "loads of", low ask, ":)", "Cheers, Tom".

ICP for this launch (Wedge Test + Discovery Patterns): AI-forward platform/devex leads and
devs running Cursor/Claude Code/MCP/agent platforms. NOT the 50-200 eng chronic-pain buyer.
The HN crowd IS this acute ICP, so lead with the agent-context angle. Drop "drift" entirely
(Barry: "no one cares about drift"); use "context agents can't see" / "shared correct
context".

Predicted objections (Positioning Lab + Discovery Patterns) and the honest answers:
- "Just a vector DB of my docs / vectorized SQLite" (Justin Mandzik): locally that's basically
  what storage is. Difference = typed conflict/supersession edges across tools + wired into
  the agent's edit loop. Admit it.
- "No proof it works" (Justin): can't prove agent quality uplift yet; what it does give is
  discrete, loggable conflict events, so a before/after is at least possible.
- Surveillance (Sam Cheng): lead with read-only + you choose sources + fully local mode.
- ADRs already do this (Barry, GOLD): not replacing ADRs, surfacing the smaller hidden
  decisions around them that never get written down. Complementary.
- Why not just CLAUDE.md (swyx wedge): one file/one repo/hand-maintained/stale, can't see a
  Jira or Slack decision, no conflict detection. This is the layer underneath.
- Open-core scepticism: CLI + MCP MIT, local mode genuinely standalone, not gating the API.
- Solo founder longevity: MIT CLI survives, local mode + export means data isn't hostage.

The actual deliverable (post, short variant, objection replies) lives in
thoughts/shared/launch/2026-06-01-show-hn.md.
