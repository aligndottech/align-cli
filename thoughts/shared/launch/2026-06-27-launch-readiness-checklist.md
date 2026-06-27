# Show HN launch-readiness checklist

Date: 2026-06-27
Umbrella: [ALI-159](https://linear.app/aligndottech/issue/ALI-159)
Plan/research: `thoughts/shared/{plans,research}/2026-06-26-oss-cli-launch-readiness.md`

The state of the launch-readiness work and the 10 must-be-true gates. The work split
into two halves: (A) the personal OSS CLI is bulletproof + value-clear, and (B) the
5-step demo flow is tested as close to e2e as possible pre-merge, to the DoD that
**green pre-merge CI predicts the manual preview/prod run works**.

## TL;DR

The hard engineering is done and merged or in review. What remains before posting is a
short list of **manual smokes** for the things CI structurally cannot prove (cold-machine
install, airplane-mode local, the agent-hook moment, the org-migration round-trip) plus
two audits (OAuth read-only scopes, free-tier telemetry). Do those, then post.

## The 10 gates

| # | Gate | Status | Evidence / how it was addressed |
|---|------|--------|--------------------------------|
| 1 | `align setup` -> `align import git` (no token) yields an answerable graph on a cold machine | code ✅ · **manual smoke pending** | Phase 0 added the empty-repo guard (`git.ts` returns `[]` on exit 128) + first-run guidance (#62). Run on a box with no `~/.config/align-cli`. |
| 2 | The PostToolUse hook injects a real conflict, stays silent when aligned | code ✅ · **manual smoke pending** | Advisory path tested (`check-advisory`); the local-mode conflict path fixed (#62). Seed a repo, make an agent edit that contradicts a decision, confirm the injected context. |
| 3 | `align setup --local` works offline (no account/network), `align ask` degrades w/o key, zero outbound | ✅ (code) · **airplane-mode smoke pending** | Fixed the clean-machine crash + ask/search/check in local mode (#62); made the ML model an optional dep + surfaced its failure (#65). |
| 4 | Free tier never gated by connector/integration limits | ✅ verified | `checkIntegrationLimit` confirmed removed; only `checkDecisionLimit` + LLM rate-limit throttle (cost, not access). |
| 5 | Typed cross-tool edges actually appear (not just `relates_to`) | ✅ at the honesty level | README reworded so the local "typed graph/conflict" claim is accurate (#62). Literal classifier-on-ingest is the chosen fast-follow (you picked reword-now). |
| 6 | personal->org migration preserves the graph + warns connectors need re-auth | verified in code · **manual e2e pending** | `orgJoinService` migrates `decision_snapshots`; oauth_tokens do NOT migrate (re-auth needed) - confirm the prompt fires in the org-join UX. |
| 7 | Read-only is true + verifiable for every personal-tier OAuth scope | **scope audit pending** | Every CLI fetcher is GET/search; audit the personal OAuth scope strings - none should include write scopes. |
| 8 | Free cloud tier captures activation/return telemetry | **verification pending** | The reason cloud is the default over local; confirm a new free signup produces retrievable activation/return events. |
| 9 | Paid value gated server-side by entitlement, fails open when enforcement off | ✅ verified | `hasFeature` server-side; `LICENSE_ENFORCEMENT_ENABLED` off by default fails open (open-core boundary rule). |
| 10 | Free-limit-exceeded routes to the founder-led path, not a dead self-serve billing flow | ✅ done | `planLimits` upsell copy reconciled to `align.tech/pricing` (#1138). |

## Demo flow tested pre-merge (DoD: green CI predicts the live run)

All against a **real Postgres** with **only the LLM/embedding boundary mocked**:

| Demo step | Coverage | PR |
|-----------|----------|----|
| Slack -> decisions + consensus | brain extraction deterministic under `BRAIN_TEST_MODE` (seam) | #1137 |
| Jira ALI-179 supersede **detection** | gateway *produces* a `supersedes` edge via `analyzeDecisionChange` (Brain mocked) | #1134 |
| Accept supersession (status flip) | real route on real DB (+ fixed a real reject-500 bug) | #1133 |
| Teams transcript conflict + **keep-new / save-all** | resolve-conflict-choice on real DB (#1133) + UI keep-new wiring (#1140) | #1133, #1140 |
| Agent connected to MCP **finds a conflict** | real in-process MCP client roundtrip -> `align.get_conflicts` | #1135 |
| LLM steps on the *real* model | opt-in canonical-input eval (skipped without `RUN_LLM_EVAL` + key) | #1137 |

The deterministic substrate (graph state machine, conflict/supersede cascades,
resolution, MCP read) is fully covered pre-merge. The genuinely non-deterministic part
(the live model classifying the demo text) is covered out-of-band by the opt-in eval -
run it once before the demo; treat drift as a signal.

## Manual smokes to run before posting

1. **Cold-machine install + cloud first-run** - fresh box / container: `npm i -g @aligndottech/cli`, `align login`, `align setup`. Confirm no native-build failure and the agent becomes graph-aware. (gates 1, 3)
2. **Airplane-mode local** - no network: `align setup --local`, `align import git`, `align ask "..."`. Confirm it works (or fails with the clear model message), zero outbound Align calls. (gate 3)
3. **Agent-hook conflict** - in a seeded repo, have the agent make an edit contradicting a known decision; confirm the injected conflict; confirm an aligned edit stays silent. (gate 2)
4. **personal->org migration** - join a personal tenant to an org; confirm decisions carry over and the connector re-auth prompt fires. (gate 6)
5. **OAuth scope audit** - grep the personal-tier OAuth scope strings; confirm no write scopes. (gate 7)
6. **Free-tier telemetry** - confirm a new free signup yields retrievable activation/return events. (gate 8)
7. **Run the opt-in LLM eval once** - `RUN_LLM_EVAL=1 OPENAI_API_KEY=... uv run pytest tests/eval/test_demo_flow_llm_eval.py` - confirm the real model still classifies the canonical inputs correctly.

## PR ledger (launch-readiness work)

Merged: #61 (research+plan+value answer), #62 (Phase 0 launch-blocker fixes),
#64 (Phase 1 MCP dispatch + login-flow), #65 (Phase 2.2/2.3 packaging + hygiene),
#1133 (supersede/keep-new routes + reject-500 fix), #1134 (auto-supersession
detection), #1135 (in-process MCP get_conflicts).

In review at time of writing: #1137 (brain seam + LLM eval), #1138 (planLimits copy),
#1140 (UI keep-new wiring).

## The value question (for the launch narrative)

Free personal CLI = a private, offline-capable **decision substrate + agent guardrail**
for one dev (cloud or `--local`): the MCP server, the Claude Code hook, semantic search,
and - with the dev's own key - local relationship typing. Paid = the **hosted, key-free,
real-time, trained intelligence at team scale**: ambient capture, the trained classifier,
the server-side cross-tool pipeline, the shared team graph. The funnel trigger is a
*sharing* need, not a feature wall; lead solo positioning on the agent-hook moment, not
graph browsing. Full matrix + funnel risks in the research doc.