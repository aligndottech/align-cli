# Plan: OSS CLI launch-readiness -> Show HN

Date: 2026-06-26
Ticket: [ALI-159](https://linear.app/aligndottech/issue/ALI-159)
Research: `thoughts/shared/research/2026-06-26-oss-cli-launch-readiness.md`

Goal: get to 1000% confidence the personal OSS CLI works perfectly on first run and
immediately adds value, AND have the 5-step demo flow tested as close to e2e as
possible pre-merge, so a Show HN launch is safe.

TDD is mandatory: every behaviour gets a RED test first (it must fail because the bug
exists / the path is uncovered), then GREEN (make it pass), then REFACTOR. Test
behaviour via the public surface; mock only at module/network boundaries.

This plan spans two repos. **`align-cli`** = Phases 0-2 + 4 (the CLI, this PR's home).
**`align-stack`** = Phase 3 (the demo-flow e2e; lands in its own align-stack PR with
its own ticket - this plan section will be copied into
`align-stack/thoughts/shared/plans/` when that work starts).

Sequencing principle: **ship the launch-blocker bug fixes first** (Phase 0). They are
small, they are on the headline paths, and they are required for an honest Show HN.
Everything else hardens around them.

---

## Phase 0 - CLI launch-blocker bug fixes (align-cli) [REQUIRED before launch]

These are verified bugs, not coverage gaps. Each: write the failing test against the
REAL code path (no mocking the thing under test), then fix.

### 0.1 Local DB directory + global crash guard (BUG-1)
- RED: a test that calls the REAL `createLocalDb(<nested non-existent path>)` (not
  `os.tmpdir`, no mocking of `local-db`) and expects it to succeed - fails today with
  `SqliteError: unable to open database file`.
- GREEN: in `createLocalDb` (or `initLocalMode`) `mkdirSync(dirname(dbPath), { recursive: true })`
  before `new Database(dbPath)`.
- Also: wrap `initLocalMode` / the local setup entrypoints (`setup.ts:436`,
  `commands/local.ts:20,41`) in try/catch with a friendly message; add a top-level
  `process.on('uncaughtException'|'unhandledRejection')` handler in `index.ts` so no
  command can ever dump a raw stack trace.
- Files: `src/lib/local-db.ts` / `src/lib/local-mode.ts`, `src/index.ts`,
  `src/commands/local.ts`, `src/commands/setup.ts`; new
  `src/__tests__/local-db-mkdir.test.ts`.

### 0.2 `align ask` / `align search` work in local mode (BUG-2)
- RED: `why.test.ts` / `search.test.ts` cases with `resolveEnv` -> 'local' and
  `createGatewayClient` returning the local shape `{ decisions: [...] }`; assert
  results render. Throws today.
- GREEN: make the local client return `{ results, count, strategy }` (single source of
  truth, preferred) OR adapt in `why.ts`/`search.ts`. Make `ask`/`search` prefer
  local-embedded env when configured (so a no-account `--local` user does not silently
  hit prod).
- Files: `src/lib/local-gateway-client.ts` (+ shared response type in
  `gateway-client.ts`), `src/commands/why.ts`, `src/commands/search.ts`,
  `src/commands/*` env resolution; `src/__tests__/why.test.ts`, `search.test.ts`.

### 0.3 `align check --env local` reports conflicts (BUG-3)
- RED: a `check.test.ts` case driving the command with the local client shape and a
  real conflict; assert a conflict is rendered. Silent today.
- GREEN: make the local client emit the cloud `AlignmentResult` enum
  (`aligned|conflicting|no-context`) + `conflicts` field; add a contract test asserting
  both clients return identical status enum + field names.
- Files: `src/lib/local-gateway-client.ts`, `src/commands/check.ts`; new
  `src/__tests__/alignment-result-contract.test.ts`.

### 0.4 `align import git` handles an empty repo + uses GitFetcher (BUG-5)
- RED: mock `getCommitHistory` to reject (execa exit 128); assert a friendly message
  and non-crash. Crashes today.
- GREEN: try/catch in `commands/import/git.ts` (mirror `setup.ts:680-682`); make
  `getCommitHistory` return `[]` on the empty-repo exit-128; refactor the wrapper to
  call `fetchGitItems` so it inherits the tested mapping incl. author.
- Files: `src/commands/import/git.ts`, `src/lib/git.ts`; new
  `src/__tests__/import-git.test.ts`.

Phase 0 verification: `npm test && npm run typecheck && npm run lint && npm run build`,
plus a manual cold-machine smoke: `align setup --local` then `align ask` on a box with
no `~/.config/align-cli/`.

---

## Phase 1 - Core-surface coverage (align-cli) [REQUIRED for the wedge; raise ratchet]

### 1.1 MCP CallTool dispatch (the product wedge) - HIGHEST priority
- Refactor the `CallToolRequestSchema` switch in `commands/mcp.ts` into an exported
  pure `dispatchTool(name, args, client, env)`.
- RED/GREEN tests: each tool routes to the correct client method with the right args
  (`align_ask` defaults limit 8; `align_get_related_decisions` builds
  `${file_path} ${context}` limit 5); `align_capture` classifies slack/jira/confluence/
  github/linear URLs and defaults to 'web'; `align_capture` throws "requires a URL" in
  cloud mode for raw text but passes raw text in local mode; unknown tool throws.
- Files: `src/commands/mcp.ts`; new `src/__tests__/mcp-dispatch.test.ts`.

### 1.2 `lib/login-flow.ts` (the only cloud-login path)
- Tests (mock `waitForCallback`, fetch, `open`, `createGatewayClient`): success
  persists token + tenant id; missing token -> false + "No token received"; whoami
  rejection still saves token and returns true (offline-verify fallback) - BUT
  distinguish 401/403 (token rejected -> do NOT persist, return false) from network
  (status 0 -> persist + warn). The latter is a behaviour fix, write the test for the
  fixed behaviour.
- Files: `src/lib/login-flow.ts`; new `src/__tests__/login-flow.test.ts`.

### 1.3 Cloud auth UX (friendly errors + timeout)
- Tests: unauthenticated cloud command exits 1 with a message containing "align login";
  401 vs 403 vs 5xx map to distinct actionable messages; a never-resolving fetch is
  aborted with a "timed out" message (fake timers).
- GREEN: add a shared auth guard (mirror `login.ts:50`), branch on status code in the
  client, add an `AbortController` default timeout (~30s) to `request()`.
- Files: `src/lib/gateway-client.ts`, command catch handlers; `gateway-client.test.ts`.

### 1.4 Remaining command logic
- `commands/login.ts` (--token save, whoami guard, logout); `commands/local.ts`
  (status/reset incl. WAL/-shm cleanup); `commands/capture.ts` (URL-vs-text, platform
  label, connector hint); `commands/import.ts` (single-vs-bulk, SSE, --approve
  async-vs-sync); `commands/import/{jira,confluence}.ts` auth precedence (explicit
  token vs cached OAuth; "No credentials" vs "OAuth metadata incomplete";
  AuthExpiredError -> reconnect).
- Files: respective commands; new test files per command.

### 1.5 Empty/first-run UX (the no-wow loop)
- Test: when git seed yields 0 decisions, setup steers the user to a connector import
  (or `--local` seed), and `align ask` empty-state copy does NOT recommend the action
  that just produced nothing.
- Files: `src/commands/setup.ts`, `src/commands/why.ts`.

Phase 1 verification: full gate green; then **raise the coverage ratchet** in
`vitest.config.ts` (statements/lines 45 -> ~60, branches/functions 70 -> ~80) so CI
locks in the gains.

---

## Phase 2 - Positioning honesty + packaging hygiene (align-cli) [REQUIRED for launch]

### 2.1 Resolve the "typed graph / conflict" claim (BUG-4) - DECISION NEEDED
- Option (a) low-risk: reword README + any marketing copy to "builds a local decision
  graph and surfaces likely-related decisions via on-device embeddings; LLM
  relationship typing (supersedes/refines/conflicts/...) runs at query time when you
  add your own API key". Stop calling the persisted local graph "typed" and similarity
  links "conflicts".
- Option (b) literally-true: invoke `classifyRelationship` during `ingestOne` for the
  top similar candidates and persist `rel.type` into `decision_links` (with
  `relates_to`/untyped fallback when no key). RED: a local-import test asserting a
  seeded superseding pair produces a `supersedes` edge (with key stubbed), not a
  hardcoded `conflicts_with`.
- Recommend (a) before launch + (b) as a fast-follow. Confirm in scoping.

### 2.2 Native-deps + model-download first-run safety
- Make `@xenova/transformers` optional or lazy-installed (only needed for `--local`),
  so cloud-only users do not compile `sharp`/`onnxruntime` at global install; OR add a
  Docker Alpine + ARM64 install-smoke CI job and a README note on the native-prebuild /
  offline-compile prerequisite. Surface the ~90MB model download with an explicit,
  actionable error on failure (stop swallowing it as "Git import skipped").
- Files: `package.json`, `src/lib/local-embeddings.ts`, `src/commands/setup.ts`,
  `README.md`, `.github/workflows/ci.yml`.

### 2.3 OSS hygiene
- Add `SECURITY.md`, `CONTRIBUTING.md`, an issue + PR template; add a `prepublishOnly`
  build script; fill npm metadata (bugs/homepage/keywords/author); update LICENSE +
  CHANGELOG dates. Reconcile `planLimits` upgrade copy with the founder-led motion
  (this lever lives in align-stack; track as a cross-repo item).

---

## Phase 3 - Demo-flow e2e (align-stack) [the "as close to e2e as possible" ask]

Lands in an align-stack PR (own ticket). Architecture = the HYBRID verdict: stub the
LLM at the brain HTTP boundary, run everything else real, split assertions across a
deterministic backbone + thin orchestration on top. Build in this order:

### 3.1 Deterministic gateway integration tests (the backbone) - start here, no new infra
Real Postgres (`*.integration.test.ts` pattern, runs in CI `test-typescript`), brain
mocked at the fetch boundary. Close the demo-critical gaps:
- **Jira supersede status flip:** drive `POST /decisions/:id/supersede {old_decision_id, accept:true}`,
  assert old=`superseded` + `superseded_by`, link `detection_method='user'`. (No test
  today.)
- **Auto-supersession edge:** call `analyzeDecisionChange` (mock brain `/analyze_change`
  to return `supersedes`), assert a `decision_links supersedes` row + `decision_changes`
  + old decision repointed. (Hand-inserted today.)
- **Teams keep-new / save-all:** drive `POST /decisions/resolve-conflict-choice {choice:'keep_new'}`
  on seeded old+new+`conflicts_with` link, assert old=archived/new=active/link
  resolved/`decision_changes user_keep_new`. (Mocked-SQL only today.)
- **MCP alignment conflict verdict:** extend `alignmentCheck.test.ts` - mock brain
  embed + `/analyze_change` (conflicts_with), assert `status:'conflicting'` citing
  decision Y; add a brain `/analyze_change` pytest (mirror `test_alignment.py`).

### 3.2 Brain deterministic fixture seam (prerequisite code change)
- Extend `BRAIN_TEST_MODE` (`main.py:42`) to gate `/synthesize`, `/synthesize-consensus`,
  `/analyze-conversation`, `/analyze_alignment`, `/analyze_change` with rich canned
  fixtures keyed off demo inputs (model on `_generate_canned_batch_response`). The
  alignment fixture MUST return a real conflict (the no-LLM path returns none today).
  Fail LOUD on a fixture miss. Wire `BRAIN_TEST_MODE=true` into the compose brain env.
- Fixtures in `services/brain/tests/fixtures/demo_flow/*.json` (reviewable artifacts).

### 3.3 The two UI/agent moments
- **Keep-new (Playwright, real stack):** seed the `conflicts_with` edge via
  `TestDatabase.createLink`, drive the BulkApprovalResults modal "Keep New" click,
  assert the green check AND the DB state (both `resolved`, link `metadata.resolved`,
  `decision_changes`). Add `data-testid`s. Fallback: assert the resolve endpoint
  directly. (The LLM that *produces* the conflict is non-deterministic - seed it.)
- **Agent-via-MCP (in-process client):** build `createMcpServer(new AlignGatewayClient(...))`,
  connect via the SDK `InMemoryTransport.createLinkedPair()`, `callTool('align.get_conflicts')`,
  assert `conflict_count >= 1` over seeded data. Deterministic (pure SQL). Do NOT gate
  on `align.check_alignment` (LLM-dependent; keep for non-blocking preview smoke).

### 3.4 Optional stretch: orchestrated full-flow CI job
Once 3.2 exists, a single `docker-compose.ci.yaml --profile all-connectors` job that
injects signals at the connector/gateway ingest endpoints in demo order and asserts
graph + bot-card capture. Serial (`workers:1`), bounded readiness retries, structural
assertions only. One run per PR (multi-minute boot). Acknowledge the gap: real
Slack/Teams/Jira bot round-trip stays manual (Tier-4 smoke).

Phase 3 verification: gateway `vitest run` (integration green w/ DATABASE_URL), brain
`uv run pytest`, `ui pnpm run test:e2e`, and (if built) the orchestrated job.

---

## Phase 4 - Launch checklist / gates (the "1000% confident" gate)

Convert the must-be-true gates (research section 1) into an executable pre-Show-HN
checklist. Do NOT post until all pass:

- [ ] Cold-machine `align setup` -> `align import git` (no token) -> non-empty graph ->
      `align ask` answers. (Gate 1; depends on Phase 0 + 1.5)
- [ ] `align setup --local` on an airplane-mode box: setup + import git + ask succeed,
      zero outbound Align calls, no crash. (Gates 3; depends on Phase 0.1-0.2)
- [ ] Seeded-repo agent edit that contradicts a known decision -> visible injected
      conflict via the hook; aligned edit stays silent. (Gate 2)
- [ ] Connecting any source on a free tenant never returns an integration-limit error.
      (Gate 4)
- [ ] Seeded git+Linear/Jira corpus with a known superseded decision yields a correctly
      typed `supersedes`/`conflicts_with` edge in `align links list`. (Gate 5; depends
      on Phase 2.1 decision)
- [ ] personal->org migration: N decisions in -> N in the org graph + explicit
      connector re-auth prompt. (Gate 6)
- [ ] Audit personal-tier OAuth scopes: no write scopes anywhere. (Gate 7)
- [ ] Free signup generates retrievable activation/return telemetry. (Gate 8)
- [ ] `LICENSE_ENFORCEMENT_ENABLED` unset -> self-host never locked out. (Gate 9)
- [ ] Free-limit-exceeded routes to the founder-led/contact path, not dead self-serve
      billing. (Gate 10)
- [ ] The 5-step demo flow passes the Phase-3 hybrid suite green in CI.
- [ ] OSS hygiene present (SECURITY/CONTRIBUTING/templates); README claims match code
      (Phase 2.1).
- [ ] `npm i -g` smoke on Alpine + ARM64 (or transformers made optional). (Phase 2.2)

---

## Suggested follow-up tickets (cut from this plan)

- `align-cli`: Phase 0 launch-blocker fixes (one ticket, RED-first).
- `align-cli`: MCP dispatch + login-flow coverage (the wedge).
- `align-cli`: cloud-auth UX (friendly errors, timeout, expiry).
- `align-cli`: positioning/honesty fix (README + optional classifier-on-ingest).
- `align-cli`: packaging (optional transformers / Alpine+ARM CI / hygiene files).
- `align-stack`: demo-flow deterministic integration tests (supersede flip,
  auto-supersession, keep-new, alignment verdict).
- `align-stack`: BRAIN_TEST_MODE fixture seam + (optional) orchestrated compose e2e.
- `align-stack`: Playwright keep-new + in-process MCP get_conflicts e2e.