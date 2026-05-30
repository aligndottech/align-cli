# Plan: Solo = personal CLOUD tenant by default; `--local` is the opt-in escape hatch

## Decision (2026-05-30, supersedes the earlier "solo → local default" in this doc and in PR #20)

**Solo dev = a personal CLOUD tenant by default.** `align login` (personal email → personal tenant, auto-provisioned server-side) → personal-scoped connector OAuth → cloud cross-tool graph. The local-embedded SQLite mode (#18) is **demoted to an opt-in `--local` privacy/offline escape hatch**, not the default.

Why (from memory `project_cli_solo_local_direction`): cloud gives telemetry (don't fly blind pre-PMF), a real upgrade path that reuses the personal→org migration (#1035), the real cloud relationship classifier, and backup/cross-device. Tom's original pains were **not** "cloud" — they were (a) org-level app installs (fix: personal-scoped OAuth, which the gateway already does per-tenant), (b) the Sonnet-4 cost spike (fix: Haiku in fast-mode synthesis), (c) connector friction (fixed in #20).

Research backing this plan: `align-stack/thoughts/shared/research/2026-05-30-cli-phase3-personal-cloud-connectors.md`.

## Key research findings that shape the plan
- **No gateway changes needed for "personal-scoped OAuth."** Connector OAuth auto-binds to the logged-in user's tenant (`integrationCredentialRoutes.ts:133-161` → `getTenantFromReq` → `oauth_tokens(tenant_id, connector_key)`). A personal-email login lands on an isolated personal tenant (`provisioning.ts`, `signup_source='personal'`). The CLI already uses the personal GitHub key (`github-personal`, `setup.ts:53`).
- **Connector tiers:** frictionless-personal = GitHub / GitLab / Linear / Notion / Zoom; site-scoped per-user = Jira / Confluence (single Atlassian consent); needs-workspace-admin = Slack / Teams (label these).
- **Upgrade (orgJoinService #1035):** decisions migrate; `oauth_tokens` do **not** (re-auth required); `api_tokens` expire (CLI re-login). No `align join` CLI command exists — upgrade is web `/join?token=`. Nothing to build CLI-side; outro should point there and set the re-auth expectation.
- **Cost:** `--local` is already $0 + lazy-Haiku typing (#21). Cloud bulk import currently hits **Sonnet-4** because `/synthesize?mode=fast` (`brain/app/main.py:1738-1745`) uses `create_llm_client_for_tenant` (managed default Sonnet-4), not the Haiku `resolve_fast_json_config` that `synthesize_consensus` already uses (`main.py:1975-1977`).

## Decisions locked with the user (2026-05-30)
- **Haiku cost fix is IN this Phase 3 work**, as a separate commit (touches align-stack brain).
- **No-auth default:** interactive cloud path with no session → log in **inline** (browser flow), continue; cancel → offer `--local`. Scripted `--approve` with no session → error exit 1 (today's behavior). `--local` → always local, no auth.

---

## Phase 1 — Flip the setup default (solo = cloud personal; local behind `--local`) [align-cli]

### 1.1 RED — update `src/__tests__/setup.test.ts`
The existing "solo / local mode" block encodes the *old* model and must flip:
- `--local` → `initLocalMode` called, `whoami` NOT called, no connector multiselect, git imported. **(keep — behavior unchanged)**
- **CHANGE:** "defaults to solo→local when interactive" → new: **default (interactive, authenticated) routes to the CLOUD path** — `whoami` called, `initLocalMode` NOT called, connector multiselect shown. The local path is reached only when the user selects the local option (new select value `'local'`) or passes `--local`.
- `--approve` → cloud path, `whoami` called, `initLocalMode` not called **(keep)**.
- New: interactive select offering `'cloud'` (default) vs `'local'`; choosing `'local'` → `initLocalMode`, no `whoami`.
Update `mockSelect` default from `'team'` to `'cloud'` and rename old `'solo'`/`'team'` assertions to `'local'`/`'cloud'`.

### 1.2 GREEN — `src/commands/setup.ts`
- Rename `runSoloSetup()` → `runLocalSetup()` (behavior identical — it is the LOCAL path). Update the comment ("solo == local" is no longer true).
- Step-0 mode resolution:
  - `opts.local` → `local`.
  - `opts.approve` → `cloud` (no prompt).
  - else interactive `p.select`: `{ cloud (recommended): "Cloud — your personal graph, syncs, upgradeable to a team", local: "Local only — private, offline, no account (--local)" }`, `initialValue: 'cloud'`.
- `mode === 'local'` → `await runLocalSetup(); return;`. Otherwise fall through to the cloud path (current team branch, `setup.ts:374-568`).

### 1.3 REFACTOR
Extract the cloud branch body into `runCloudSetup(opts, config, env, client, envName)` so `registerSetupCommand`'s action stays small (file is ~570 lines, under the 900 cap but trending up).

**Verify:** `npm test`, typecheck, lint, build.

---

## Phase 2 — Inline login on the interactive cloud path when unauthenticated [align-cli]

### 2.1 RED
`setup.test.ts`: when interactive (not `--approve`), `whoami` rejects first (unauthenticated) but an inline login helper resolves a token, then `whoami` succeeds → setup continues into MCP/connector steps (no `process.exit`). Separately, `--approve` + `whoami` reject → still exits 1 with the "align login" warning (keep existing test at line 86-93).

### 2.2 GREEN
- Extract the browser-login core from `login.ts:27-79` into a reusable `loginInteractive(env, envName, config): Promise<boolean>` in `src/lib/` (or export from `login.ts`). `registerLoginCommands` calls it; setup calls it.
- In `runCloudSetup`, wrap the auth check: on `whoami` failure, if interactive → `p.confirm("Log in now?")` → `loginInteractive(...)`; on success re-create the client with the new token and continue; on cancel/fail → offer `--local` (`p.confirm`) or exit. If `--approve` → keep the current exit-1 warning.

### 2.3 REFACTOR
Dedupe the spinner/`waitForCallback` block now shared between `login` and `setup`.

**Verify:** tests, typecheck, lint, build.

---

## Phase 3 — Connector ordering + personal/workspace labelling [align-cli]

### 3.1 RED
`setup.test.ts`: assert the connector multiselect options are ordered personal-frictionless first (github, gitlab, linear, notion, zoom), then jira/confluence, then slack/teams; and that slack & teams hints contain a "workspace/org admin" note.

### 3.2 GREEN
- Reorder `buildSources()` (`setup.ts:48-151`) or sort at multiselect build time so personal-frictionless connectors lead.
- Append to slack/teams `description`: `" - may need workspace/org admin"`.
- Confirm GitHub stays on `github-personal` (already `setup.ts:53`).

### 3.3 REFACTOR
Introduce a `tier: 'personal' | 'site' | 'workspace'` field on `SetupSource` and derive order + label from it (clearer than hand-sorting).

**Verify:** tests, typecheck, lint, build.

---

## Phase 4 — Upgrade-to-team outro on the cloud personal path [align-cli]

### 4.1 RED
`setup.test.ts`: the cloud-path outro mentions upgrading to a team (web `/join` / pricing) AND notes connectors re-auth after joining. (Pricing link assertion at line 199-203 stays green.)

### 4.2 GREEN
In `runCloudSetup`'s outro, add a line: team upgrade via the web join flow, and a one-liner that connectors must be reconnected after joining an org (since `oauth_tokens` don't migrate — research Q3). Do NOT add an `align join` command.

### 4.3 REFACTOR
None expected.

**Verify:** tests, typecheck, lint, build.

---

## Phase 5 — Haiku for cloud fast-mode synthesis (cost) [align-stack brain, SEPARATE COMMIT]

### 5.1 RED
`services/brain/tests/`: a test for `POST /synthesize?mode=fast` asserting the LLM client is created with the Haiku scan model (`resolve_fast_json_config`) for an `align_managed` / Anthropic-only tenant, mirroring the existing `synthesize_consensus` fast-mode behavior. Mock the LLM client; assert the selected model id == `ANTHROPIC_SCAN_MODEL` default (`claude-haiku-4-5-20251001`).

### 5.2 GREEN
In `brain/app/main.py:1736-1745`, when `fast_mode`, select the model via `resolve_fast_json_config(tenant_config)` (Haiku) instead of the tenant default, matching `synthesize_consensus` (`main.py:1975-1977`). Keep `ANTHROPIC_SCAN_MODEL` overridable; non-fast (agentic) path unchanged.

### 5.3 REFACTOR
If both `synthesize` and `synthesize_consensus` now share the same fast-mode model-selection, extract a small helper.

**Verify:** `cd services/brain && uv run pytest`; ruff check/format. Confirm no fast-mode quality regression in existing synthesize tests.

---

## Verification of the upgrade path (no build) [align-stack]
`orgJoinService` (#1035) already exists + is tested. "Verify the upgrade reuses it" = confirm `executeOrgJoin` + web `/join` are intact and the CLI outro (Phase 4) points there. No CLI join code in this PR.

## Success Criteria
- [ ] Default `align setup` (interactive) routes to the **cloud personal** path; `--local` is the only local path.
- [ ] Unauthenticated interactive cloud setup logs in inline and continues; `--approve` unauth still exits 1.
- [ ] Connectors ordered personal-first; Slack/Teams labelled workspace/admin; GitHub uses `github-personal`.
- [ ] Cloud outro explains team upgrade + connector re-auth.
- [ ] `/synthesize?mode=fast` uses Haiku for managed tenants.
- [ ] All tests pass; typecheck; lint; build — both repos. No regressions to `--local`, `--approve`, Atlassian single-consent, or MCP-first ordering.

## Rollback Plan
Each phase is independent and test-gated; revert per-commit. Phase 5 is a separate commit in a separate repo. The default flip (Phase 1) is the only behavior change to existing users; `--local` preserves the old solo experience.

## Open Questions
1. `loginInteractive` extraction location — `login.ts` export vs new `src/lib/login-flow.ts`. Lean to a `src/lib/` helper for testability (Phase 2.2).
2. Should `--approve` on the cloud path also auto-pick all frictionless connectors, or none (current: none)? Keep none — scripted runs shouldn't trigger browser OAuth.
