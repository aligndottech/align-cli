# Research: OSS CLI launch-readiness + the personal-tier value question

Date: 2026-06-26
Ticket: [ALI-159](https://linear.app/aligndottech/issue/ALI-159)
Author: Tom (+ Claude harness)

Sources: two parallel research workflows over the real code (19 sub-agents,
~2.1M tokens, every claim file:line-cited).
- Workflow A (11 agents): `align-cli` test coverage, first-run/time-to-wow, the
  free-vs-paid value boundary, cloud/auth robustness, imports, packaging, funnel
  - plus 4 adversarial verifiers that re-read the code to try to refute the
  riskiest launch claims.
- Workflow B (8 agents): the 5-step demo flow (Slack -> consensus -> Jira
  supersede -> Teams-transcript conflict + save-all/keep-new -> agent-via-MCP
  conflict) mapped to `align-stack` code, existing tests, and the best
  automatable e2e harness, plus 2 feasibility verifiers.

Repos in scope: `align-cli` (the OSS personal CLI, `@aligndottech/cli` MIT v0.4.0)
and `align-stack` (the closed gateway/brain/connectors that hold the paid
intelligence and the demo flow).

---

## TL;DR (read this first)

**The personal CLI is NOT Show-HN-ready today.** It is close, and the foundations
are genuinely good, but the adversarial pass found verified, launch-blocking bugs
on the exact paths a Hacker News audience will hit first, plus a positioning claim
that a source-reading audience can refute. None of these are visible in the current
test suite (227 tests pass, but they mock the broken paths).

Three things, in priority order:

1. **There are real first-run bugs, not just missing tests.** Local/offline mode -
   the headline privacy differentiator the HN crowd will deliberately choose -
   **crashes on the first command on a clean machine** (missing DB directory), and
   `align ask` / `align search` **crash in local mode** (response-shape mismatch),
   and `align check --env local` **silently never reports a conflict** (status-enum
   mismatch). See "Verified launch-blocking bugs".

2. **The "builds a typed graph + detects conflicts standalone" claim is overstated**
   and an HN reader can refute it from the source. Locally, every imported edge is
   hardcoded `conflicts_with` by cosine similarity; the 8-type LLM classifier never
   runs during import and only runs at query time with the user's own key. Fix the
   copy or fix the code before launch (see "The value boundary").

3. **The coverage gap that matters most is the MCP CallTool dispatch** (the literal
   agent integration point, the product's wedge) and the shared cloud-login flow -
   both at 0%.

Coverage baseline (main, 2026-06-26): **227 tests / 27 files pass; 51% lines, 77%
branches, 76% funcs.** The number is not the problem; *which* paths are uncovered is.

**The strategic answer (the value question), in one paragraph:** the free personal
CLI is not a read-only teaser. It gives a solo dev a real, private, on-device
decision substrate (SQLite + on-device embeddings, zero key, zero network) plus the
entire agent-context surface the paid product is built on - an 8-tool MCP server, a
fail-open Claude Code hook, and editor rules that make the agent consult past
decisions before it edits. What is genuinely paid is the *hosted, key-free,
real-time, trained intelligence at team scale*: ambient capture, the trained
relationship classifier, the server-side cross-tool pipeline, and the shared team
graph. So the funnel is sound in principle - free solo value is the agent guardrail;
the upgrade trigger is a *sharing* need, not a feature wall - but its load-bearing
risk is that solo value is thin, and the product (and the HN post draft) already
admit this. Details and the must-be-true gates below.

---

## 1. The value question, answered: what the free personal CLI is worth

> "What value does this give devs/users when the real-time relationship detection
> and building up of the decision graph comes from the team/paid/enterprise tier?"

The premise needs one correction: **the decision graph and relationship typing are
NOT exclusively paid.** The free CLI builds a graph locally and can type relationships
locally (with the user's own LLM key). What is exclusively paid is doing it *for you,
key-free, in real time, at team scale, with trained models*.

### Capability matrix (ground truth from code)

| Capability | free local, no key | free local, +own key | free cloud (default) | paid team |
|---|---|---|---|---|
| Local typed graph store (SQLite: decisions + embeddings + links) | full | full | full | full |
| On-device embeddings / semantic search (no network) | full | full | n/a (server-side) | full |
| `align ask` ranked retrieval | full | full | full | full |
| `align ask` natural-language synthesis | degraded (ranked list) | full | full | full |
| Drift check (cosine vs a decision) | full | full | full | full |
| MCP server for IDE agents (8 tools) | full | full | full | full |
| Claude Code PostToolUse advisory hook | degraded (related only) | full | full | full |
| Typed relationship edges (8-type taxonomy) | degraded -> `relates_to` | full (at query time) | full | full |
| Conflict detection on a proposed change | degraded (never "conflict") | full | full | full |
| Typed classification done FOR you at ingest, no key | none | none | full (server-side) | full |
| Cross-tool linking across many tools | degraded (git + paste-token) | degraded | full | full |
| Ambient / real-time capture (webhooks) | none | none | none | **full only here** |
| Trained classifier + fine-tuned LLM + graph/sequence models | none | none | none | **full only here** |
| Shared team graph + web UI + cross-machine sync | none | none | degraded (personal sync) | full |
| Governance / SSO / seat enforcement | none | none | none | full |

Evidence: `local-db.ts:27-50` (typed graph schema), `local-embeddings.ts:4-11`
(on-device MiniLM), `local-gateway-client.ts:135-147` (query-time classifier),
`local-relationship-classifier.ts:9-50` (8-type taxonomy, returns null without a
key), `AmbientCaptureEngine.ts:43-45` (entitlement-gated, no CLI path),
`relationship_classifier.py:22-74` (trained Brain classifier),
`decisionAnalysis.ts:33-54` (server-side two-stage cross-tool pipeline).

### What the free tier uniquely gives a solo dev

A private, offline-capable **decision substrate + agent guardrail** that does four
concrete jobs for one developer and their agent, none requiring a team or the paid
engine:

1. **A queryable graph from your own git history, zero auth, zero cost** -
   `align import git` needs no token. Turns "why did past-me do this?" into
   `align ask "why do we use postgres"` answered from commit reasoning. (On a team
   the value is "you can't go ask the person who left"; solo, past-you is unreachable
   too, and the agent never had the why at all.)
2. **The agent-context surface, scoped to one dev's loop** - MCP server + a
   PostToolUse hook that injects conflicting decisions after an edit + managed
   `CLAUDE.md` / `.cursor/rules` nudges. The value is the guardrail firing whether or
   not the model remembers to ask.
3. **Genuinely standalone, no lock-in** - `--local` runs fully offline (SQLite +
   on-device embeddings, optional typing via the dev's *own* key/Ollama), MIT,
   exportable. Pays nothing, sends nothing, can leave with the data.
4. **Real typed work even in cloud-default solo mode** - candidate pairs by cosine,
   typed lazily into the taxonomy via the user's key, so a solo dev with a couple of
   sources gets supersession/conflict edges, not a flat vector dump.

### What is genuinely paid (the moat)

- **Ambient / real-time capture** (`AmbientCaptureEngine`, entitlement-gated; the CLI
  has no webhook/real-time path - all free capture is explicit).
- **Typed classification done for you, key-free, at scale** - the gateway+Brain
  two-stage pipeline runs server-side across all tools in the background.
- **The trained intelligence** - GradientBoosting classifier + fine-tuned LLM (11-type
  taxonomy), graph algorithms, the sequence model. None ship in the CLI.
- **Shared team graph + web UI + cross-machine sync, OAuth onboarding breadth,
  write-back bots (tag-only), governance/SSO/seat enforcement.**

### The funnel logic (and why it can work)

1. **Acquire (free):** `npm i -g`, `align setup`, default personal cloud tenant.
2. **Activate:** the agent surfaces a forgotten/conflicting decision mid-edit. North
   star = "5 strangers use it and come back" (use-then-return, not pay).
3. **Expand in place (free):** connect more read-only sources -> richer cross-tool
   edges -> climbs toward the 3,000-decisions/month free ceiling.
4. **Trigger (upgrade):** a *sharing* need ("I want my whole squad's decisions in
   here / conflicts across squads"), not a feature wall.
5. **Convert:** the existing `orgJoinService` migrates the personal graph into the
   shared team tenant (decisions migrate; oauth_tokens do NOT -> connectors need
   re-auth). Sunk effort carries over.
6. **Buyer handoff:** the developer is the vector, not the buyer; founder-led
   Design-Partner / Enterprise engagement.

### Funnel risks (honest)

| Risk | Severity | Mitigation |
|---|---|---|
| Solo standalone value is too thin to retain (the HN draft itself asks this) | high | Lead solo positioning on the agent-hook moment, not graph browsing; instrument cloud-default activation + 7/30-day return *before* scaling acquisition; treat failure-to-retain-5-strangers as a kill/iterate signal |
| "Just a vector DB + an LLM call" critique is partly true for the OSS path | high | Be precise the moat is typed cross-tool edges in the agent loop + future hosted intelligence; ensure typed edges actually appear on realistic solo data; never self-deprecate, never overclaim |
| Conversion needs a team trigger solo users may never develop; dev != buyer | medium | Make value visibly scale with team size; surface the migration-preserves-effort story at upgrade; feed founder-led outreach in parallel |
| Cloud-default erodes the privacy story that attracts the HN/solo crowd | medium | Make `--local` first-class in setup/docs; keep read-only + "you choose sources" front and centre |
| Open-core "free is a crippled demo" suspicion + solo-founder longevity fear | medium | Hold the open-core line (never gate connectors/API; `hasFeature` server-side only); keep MIT + working local + `align export` as the "your data isn't hostage / it survives me" answer |
| In-product upgrade copy contradicts GTM: `planLimits.ts` still points to a self-serve `/settings/billing` Team tier that public pricing retired | low | Route the free-limit-exceeded message to a Design-Partner/contact path; fix the `planLimits.ts` header comment |
| Migration gap: decisions migrate but oauth_tokens do not -> connectors break on join | low | State the re-auth caveat *at* upgrade; verify the org-join UX actually prompts it |

### Must-be-true gates (each is a pre-launch checkpoint)

These are the product facts the funnel depends on. They double as the launch
checklist (see plan Phase 4):

1. `align setup` -> `align import git` succeeds with no token and produces an
   answerable graph on a cold machine.
2. The PostToolUse hook installs on setup, runs `align check --advisory`, exits 0,
   and injects a real conflicting decision on a genuine conflict (silent when
   aligned).
3. `align setup --local` works with no account/network; `align ask` degrades to a
   ranked list with no key; zero outbound Align calls. **(Currently fails - see bugs
   #1 and #2.)**
4. Free tier is never gated by connector/integration limits (only decision volume +
   LLM rate). `checkIntegrationLimit` confirmed removed.
5. Typed cross-tool edges actually appear for a realistic solo dataset (not just
   `relates_to`). **(Currently the persisted local graph is mono-typed - see bug #4
   / honesty gap.)**
6. personal->org migration preserves the graph AND warns connectors need re-auth.
7. Read-only is true and verifiable for every personal-tier OAuth scope (no write
   scopes).
8. Free cloud tier captures activation/return telemetry (the reason cloud is the
   default).
9. Paid value is gated server-side by entitlement, never a connector-side boolean,
   and fails open when enforcement is off.
10. The free-limit-exceeded message routes to the founder-led path, not a dead
    self-serve billing flow.

---

## 2. Verified launch-blocking bugs (adversarial pass)

These were found by re-reading the code to *refute* launch claims. All are on the
first-run/headline paths and all are currently invisible to the test suite.

### BUG-1 (blocker): `align setup --local` / `align local start` crash on a clean machine

`initLocalMode()` -> `createLocalDb(~/.config/align-cli/local.db)` calls
`new Database(dbPath)` but **nothing ever creates the parent directory**.
better-sqlite3 creates the file, not the dir, so a pristine machine throws
`SqliteError: unable to open database file`. There is no try/catch and no global
`uncaughtException` handler, so it surfaces as a raw stack trace and a non-zero exit.
Note `Conf` uses `~/.config/align-cli-nodejs/` (env-paths `-nodejs` suffix) - a
*different* directory - so it does not pre-create the DB dir either.
Evidence: `local-mode.ts:14,30`, `local-db.ts:53`, `setup.ts:436`, `index.ts:65`
(no handler). The local path is the headline privacy differentiator; this is a
public faceplant on the first command.
Fix: `mkdirSync(dirname(dbPath), { recursive: true })` before `new Database`, wrap
local entrypoints in try/catch with a friendly message, add a top-level
`uncaughtException`/`unhandledRejection` handler, regression test the REAL
`createLocalDb` against a nested non-existent dir (not `os.tmpdir`, no mocking).

### BUG-2 (blocker): `align ask` / `align search` crash in local mode

The local client returns `{ decisions }` but `why.ts` and `search.ts` read
`results.results` / `results.count` -> `TypeError` -> caught -> `process.exit(1)`.
*Also*: after `--local` setup the default env is still `prod`, so a no-account user's
first `align ask` actually targets the cloud and 401s. The only working no-key local
query path is via MCP (which serializes the raw shape).
Evidence: `local-gateway-client.ts:104-114`, `why.ts:52,100`, `search.ts:24,29`,
`config.ts:23`, `local-mode.ts:24-27`. No test covers ask/search against the local
client (`why.test.ts` mocks the cloud shape only).
Fix: normalize the local client to return `{ results, count, strategy }` (single
source of truth) or adapt in the commands; make ask/search prefer local-embedded when
configured; add RED tests against `createLocalGatewayClient`.

### BUG-3 (blocker-ish): `align check --env local` never reports a conflict

The local client returns status `'conflict' | 'related' | 'no_context'` with
`conflicting_decisions`, but `check.ts` branches on `'conflicting'` + `result.conflicts`.
So `align check --env local` and the local-mode advisory hook (wired to `--env local`)
silently never enter the conflict branch - defeating local mode's core
conflict-detection value.
Evidence: `gateway-client.ts:36-50`, `check.ts:67,79,90,174`,
`local-gateway-client.ts:128,152-157`, `agent-rules.ts:18-21`.
Fix: make the local client emit the cloud `AlignmentResult` enum + `conflicts` field;
add a contract test asserting both clients return the same status enum/field names.

### BUG-4 / honesty gap (important): the local "typed graph" is mono-typed similarity links

Local import (`ingestOne`) hardcodes `relation: 'conflicts_with'` for every cosine
match >= 0.65; the 8-type classifier is invoked **only** in `checkAlignment` (the
read path), never during import, and only types edges with the user's own key. So the
persisted local graph has exactly one machine-applied edge type, created by similarity
- and the classifier's own prompt says "high similarity alone is NOT a conflict". A
Show HN audience reading the source can refute "builds a typed graph + detects
conflicts standalone".
Evidence: `local-gateway-client.ts:58-61` (hardcoded), `:136` (classifier only in
checkAlignment), `local-relationship-classifier.ts:36-37` (prompt contradicts the
labeling).
Fix (choose in the plan): (a) reword README/marketing to be precise ("builds a local
decision graph and surfaces likely-related decisions via on-device embeddings; LLM
relationship typing runs at query time when you add your own key"), or (b) actually
invoke `classifyRelationship` during ingest for top candidates and persist the type
(with `relates_to` fallback). (a) is the low-risk pre-launch move; (b) makes the
headline literally true.

### BUG-5 (important): `align import git` crashes on an empty repo

The standalone git wrapper has no try/catch around `getCommitHistory()`; an empty
repo (`git init`, no commits) makes `git log` exit 128 and execa throws a raw stack
trace. `align setup` already guards the identical scan; the standalone command does
not. It also maps commits inline (dropping the author field) instead of using the
delegation-tested `GitFetcher`.
Evidence: `commands/import/git.ts:29-74`, `git.ts:33`, contrast `setup.ts:663-682`.

---

## 3. CLI test-coverage map (risk-ranked)

Baseline: 227 tests / 27 files; 51% lines, 77% branches, 76% funcs. The library layer
(fetchers ~92%, local-db 97%, classifier 95%, personal-import 93%, cli-oauth 87%) and
`setup.ts` (89%) / `check` / `why` (89%) are well covered. The 0% files split cleanly:

| Module | Cov | Risk | Why |
|---|---|---|---|
| `commands/mcp.ts` CallTool dispatch | 47% | **blocker** | The agent integration point - the product wedge. Tool routing, arg extraction, `align_capture` URL->platform classifier, cloud-vs-local raw-text branch all untested |
| `lib/login-flow.ts` | 0% | **blocker** | The only cloud-login path (shared by `align login` + `align setup`); incl. the gateway-unreachable "save anyway" fallback + tenant persistence |
| `commands/login.ts` | 0% | important | `--token` save (CI/self-host), whoami guard, logout |
| `commands/local.ts` | 0% | important | start/status/reset; reset deletes DB + WAL/-shm sidecars (fiddly fs) |
| `commands/import.ts` orchestration | 0% | important | single-vs-bulk branch, SSE progress stream, `--approve` async-vs-sync handling |
| `commands/import/{jira,confluence}.ts` | 0% | important | real auth-resolution precedence (explicit token vs cached OAuth; two distinct error exits) |
| `commands/capture.ts` | 0% | important | URL-vs-text rejection, 7-way platform label, connector-hint heuristic |
| `lib/gateway-client.ts` (cloud) | 56% | important | error mapping (see Cloud/auth below) |
| `commands/{search,spaces,decisions,drift}.ts` | 0% | minor | display glue over tested client methods |
| `commands/import/{git*8 others}` thin wrappers | 0% | low/info | pure glue over tested fetchers + `runPersonalImport` (git wrapper is the exception - BUG-5) |
| `commands/connector/*`, `commands/dev/*` | 0% | info | `ALIGN_INTERNAL=1`-gated; not on the public path |

(* import/git carries real logic per BUG-5; the other 8 wrappers are genuinely thin.)

---

## 4. First-run / time-to-wow

The CLI front-loads its best wow well: `align setup` writes the MCP config + the
agent-alignment files (hook/CLAUDE.md/Cursor) *before* any import, so an editor user
gets the guardrail in ~3 steps regardless of repo contents (`setup.ts:625-690`). The
strongest *standalone* wow is `align ask "..."` returning a synthesised answer with
who/when attribution - but it requires (a) the git seed produced decisions and (b) an
LLM key.

Failure modes for a brand-new user:
- **Empty/chore-only git repo -> 0 decisions.** `isDecisionCommit` rejects subjects
  < 20 chars and chore/wip/merge/etc. (`git.ts:65-68`), so "Initial commit",
  "Add README" are all dropped. Setup then says "Your agent is connected, ask it..."
  and `align ask` returns nothing, with remediation that loops back to
  `align import git` (which found nothing). (important)
- **Cloud login dead-end on headless/SSH:** a *failed* browser login `process.exit(1)`s
  with no local fallback (local is only offered if the user *declines*). (important)
- **Local model download** (~90MB MiniLM) blocks the first local import with a
  one-line warning; failure is swallowed as "Git import skipped" -> empty graph.
  (important)
- **MCP wow is deferred** to a separate editor the user must restart + a one-time hook
  approval - not visible in the terminal where setup ran. (minor)

Positive: connector OAuth dead-ends are handled gracefully (skip, not abort).

---

## 5. Cloud + auth robustness (default path)

The default env is `prod`, yet error handling is uneven:
- Unauthenticated cloud command (search/ask/decisions/capture/check) -> raw
  `Gateway returned 401 for /decisions/smart-search`, **no "run align login" hint**
  (only `whoami` guards the token). This is the single most likely first-run failure
  for a new cloud user. (important)
- **No request timeout** on the cloud client -> a hung gateway spins forever.
  (important)
- All transport errors collapse to one "Cannot reach gateway" (DNS/refused/offline/TLS
  indistinguishable). (important)
- **No token-expiry/refresh** for the gateway token - expiry looks like a generic 401.
  (important)
- `loginInteractive` fails *open*: on whoami failure it persists the token and reports
  success, swallowing a genuine 401/403 (bad token). (important)
- MCP server has **no startup auth precheck** - an unauthenticated/expired server
  boots fine and returns opaque 401s into the agent's context. (important)

Positive: the OAuth callback server (5-port fallback, 120s timeout, nonce, CORS) is
robust and well tested.

---

## 6. Packaging / native deps (public npm)

- **`@xenova/transformers` is a HARD prod dependency** that pulls `sharp` 0.32.6 +
  `onnxruntime-node` 1.14.0 (native, x64-glibc-centric, old) install scripts for
  **every** user including cloud-only. Fails on Alpine musl / some ARM. CI only tests
  x64 ubuntu/win/mac. (important - consider making it optional/lazy-installed.)
- `better-sqlite3` is a **top-level static import on the hot path of every command**,
  so a broken native addon takes down cloud mode + MCP, not just `--local`. Prebuilds
  cover supported platforms; offline/proxy/unsupported-ABI falls back to a node-gyp
  compile (needs Python + C++) and the global install fails - undocumented.
- The ~90MB model download contradicts the "fully offline" README claim and fails
  silently offline.
- Missing `CONTRIBUTING.md`, `SECURITY.md`, issue/PR templates; no `prepublishOnly`;
  stale LICENSE/CHANGELOG dates; missing npm metadata.

Positive: bin -> dist/index.js with shebang, dist ships via release build, README
otherwise accurate, version in sync, cross-platform smoke (ALI-132 done).

---

## 7. The 5-step demo flow (align-stack) - map + e2e feasibility

> NOTE: your message said "supersede one in **ALI-170**". The seeded demo in the repo
> uses **ALI-179** (`scripts/reset-demo.sh:94`, the playbook). Treating ALI-179 as
> canonical unless ALI-170 is a new variant - **flagged for confirmation**.

### The canonical narrative (already codified in seed scripts)

A 3-platform cross-tool conflict story over one problem (extract the import pipeline
from the gateway):
- **Slack** (`scripts/seed-demo-slack.sh`, 8 hardcoded messages) -> tag @Align ->
  ~5 decisions (EKS worker, SQS, batch size 8, Redis->SQS attrs, **PG pool max 10**)
  + 2 unresolved consensus topics.
- **Jira ALI-179** (manually-authored seed comments) -> `/align` extracts an adaptive-
  pool decision (~25) that **supersedes** the Slack "pool max 10".
- **Teams** (`meetingTranscripts.ts:229` `DEMO_CONFLICT_TRANSCRIPT`, deliberately
  worded to avoid supersession keywords) -> @Align transcript -> **conflicts_with**
  against the Slack/Jira decisions.

### Step -> code -> existing tests -> seam

| Step | Key code (file:line) | Existing test | Best automatable seam |
|---|---|---|---|
| 1. Slack 4 decisions + propose consensus | `eventsRoute.ts:374` -> gateway `POST /analyze-conversation` -> brain `main.py:1925`; consensus is a transient object, not a row | `test_analyze_conversation.py`, `interactions.test.ts` (unit) | `POST /analyze-conversation` (mock brain), assert decisions + `consensus_needed[].proposed_consensus`, assert NO snapshots written |
| 2. Create 5 decisions from Slack | `interactionsRoute.ts:406` -> `POST /ingest/batch` (`ingestRoutes.ts:440`, source_url #d-N disambiguation) | `ingestBatchAsync.test.ts`, `batchIngestSourceUrl.test.ts` (integration) | `POST /ingest/batch` with 5 items, assert 5 snapshots |
| 3. Jira supersede | `deferredAnalysis.ts:472` (auto edge); status flip ONLY via `POST /decisions/:id/supersede` (`decisionMutationRoutes.ts:72`) | `supersessionDetection.test.ts` (regex unit only); relationship integration hand-inserts the link | (a) `analyzeDecisionChange` with brain `/analyze_change` mocked -> assert supersedes edge; (b) `POST /decisions/:id/supersede` -> assert status flip |
| 4. Teams conflict + save-all/keep-new | `multiDecisionFlow.ts:342` saveAll -> `POST /ingest-multi/save`; keep-new -> `POST /decisions/resolve-conflict-choice` (`decisionConflictRoutes.ts:331`) | `decisionConflictRoutes.test.ts` (mocked withTenant) | `POST /decisions/resolve-conflict-choice {choice:'keep_new'}` on a real DB, assert old=archived/new=active/link resolved/decision_changes |
| 5. Agent via MCP finds a conflict | mcp-align `checkAlignment.ts` -> `POST /alignment/check` (`alignmentRoutes.ts:40`) -> brain `/analyze_change` | `alignmentCheck.test.ts` (the verdict engine, brain mocked); `tools.test.ts` (handler) | `POST /alignment/check` (mock brain embed + analyze_change) -> assert `status:'conflicting'` citing decision Y; OR in-process MCP client -> `align.get_conflicts` (SQL, deterministic) |

### Gaps that matter (demo correctness + tests)

- **`POST /decisions/:id/supersede` (the visible status flip) has ZERO tests.** (blocker)
- **No test drives auto-supersession end-to-end** (the relationship integration test
  hand-inserts the link rather than producing it via `analyzeDecisionChange`). (blocker)
- **Two divergent "keep new" implementations:** Teams `POST /decisions/resolve-conflict-choice`
  (archives old, resets new to active) vs UI `POST /decisions/:id/resolve-conflict`
  (sets both `resolved`). A test must target the surface being demoed. (important)
- **`check_alignment` fails OPEN to "aligned"** on brain timeout, and is gated by a
  0.65 similarity threshold -> a real conflict can silently vanish under load or if
  wording differs. (important)
- **Brain `/analyze_change`** (the MCP conflict classifier) has **no direct test**;
  `BRAIN_TEST_MODE` only gates `/analyze_change_batch`, which emits only
  relates/refines/supports - **never conflicts_with**. (important)
- **Jira ALI-179 seed comments are manual** (not generated by any script); an e2e must
  embed that text as a fixture. (blocker for a true e2e)

### Test-harness inventory + feasibility verdict

There is **no pre-merge harness that runs the full flow.** Three partial vehicles:
1. **UI Playwright e2e** (`ui/e2e`, runs in CI `test-e2e`): real UI + gateway +
   Postgres, but **seeds the graph via SQL** and stubs connectors/brain.
2. **Gateway integration tests** (`*.integration.test.ts`, run in CI when
   `DATABASE_URL` set): real Postgres, transaction-per-test rollback, **no brain, no
   HTTP** - call db/analysis functions directly. Strong for the state machine.
3. **docker-compose.test.yaml / .ci.yaml**: the right full topology (6 services + 4
   connectors), but **no CI job invokes it** and the only test is health smoke.

**Feasibility verdict: HYBRID** (both verifiers, high confidence). A single live-LLM
end-to-end test is not viable pre-merge (cost, minutes/run, content flake); a single
no-LLM end-to-end test runs green but proves nothing (the demo-critical brain
endpoints' offline fallbacks are *degraded* - consensus returns confidence 0.0,
alignment returns "needs_review" with no conflict). The realistic architecture:

- **Stub the LLM at the brain HTTP boundary (one seam), run everything else real.**
  Prerequisite code change: extend `BRAIN_TEST_MODE` to cover `/synthesize`,
  `/synthesize-consensus`, `/analyze-conversation`, `/analyze_alignment` (and the
  single `/analyze_change`) with rich canned fixtures keyed off demo inputs (and
  fail-loud on a fixture miss). Wire `BRAIN_TEST_MODE=true` into the compose brain.
- **Deterministic gateway integration tests** remain the authoritative backbone for
  the state-machine half (supersede status flip, auto-supersession edge, keep-new /
  save-all, alignment-conflict verdict with brain mocked).
- **UI "keep new" moment:** Playwright against the real stack with an **SQL-seeded
  conflict edge** (the LLM that *produces* the edge is non-deterministic; seed it).
- **Agent-via-MCP moment:** a **real in-process MCP client** calling `align.get_conflicts`
  (pure SQL, deterministic) over seeded data - NOT `align.check_alignment` (LLM,
  non-deterministic; keep that for a non-blocking preview smoke).
- Optional stretch: one orchestrated `docker-compose.ci.yaml` full-flow CI job once
  the brain fixture seam exists.

---

## 8. Open questions / discrepancies to resolve

1. **ALI-170 vs ALI-179** - confirm which Jira ticket the demo should supersede in.
2. **README/positioning honesty** (BUG-4) - reword the local "typed graph + conflict"
   claim, or wire the classifier into ingest? (low-risk vs literally-true)
3. **`@xenova/transformers` as a hard dep** - make optional/lazy so cloud-only users
   don't compile native modules?
4. **`planLimits.ts` self-serve Team tier** - reconcile the limit-exceeded copy +
   upgradeUrl with the founder-led motion.
5. **Is the MCP CallTool dispatch the primary OSS deliverable for launch?** If so its
   coverage is a hard blocker (it is treated as one here).
6. **Default env for OSS users** - keep `prod` (cloud) default, or steer `--local` as
   the zero-friction first run to avoid the cloud-auth failure surface on first
   contact?

---

## Appendix: raw research artifacts

- Workflow A transcript dir: `subagents/workflows/wf_b920c9ef-6d7`
- Workflow B transcript dir: `subagents/workflows/wf_da4c3929-e82`
- Full structured outputs captured in the session task outputs (`wqws58h31`,
  `wzza0hzog`).