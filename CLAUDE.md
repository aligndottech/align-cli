# Claude Code Setup for Align CLI

`@aligndottech/cli` - the open-source TypeScript CLI for Align (login, `setup`, connector imports, `ask`, MCP config). Companion to the closed `align-stack` gateway.

## Workflow (Research → Plan → Implement → Validate, mandatory TDD)

For any non-trivial change, follow the same harness as align-stack: understand the area, write a reviewable plan, then RED → GREEN → REFACTOR. See [.claude/rules/tdd.md](../align-stack/.claude/rules/tdd.md) in align-stack for the TDD cycle (test behaviors via the public API, mock only at module boundaries, never skip RED).

## Linear-Driven Workflow (always)

Every substantial change is tracked in Linear and traceable branch → ticket → PR (trivial typo fixes exempt):

1. **Ticket first** in the **Align** team (project **Align MVP**), label **`align-cli`**.
2. **Branch off latest `main`**, named **`tnk/ALI-<#>`** (e.g. `tnk/ALI-103`). One branch / one PR per ticket.
3. Reference the ticket id (**ALI-##**) in the PR title or body.
4. Linear MCP is configured in align-stack's `.mcp.json`; reconnect if its tools aren't available.

## Repo specifics (READ THIS)

- **Package manager: `npm`** (NOT pnpm). The lockfile is `package-lock.json`. Use `npm install` / `npm ci` - do not introduce `pnpm-lock.yaml`.
- **Node ≥ 22.16** (CI's required `test` job runs the floor, 22.16; `test-node24` runs the
  other end). The floor is `node:sqlite`, which `src/lib/local-db.ts` uses for the local
  graph - unflagged from 22.13, and `DatabaseSync.isTransaction` lands in 22.16. There is
  **no native dependency left**, which is what lets one runner cross-compile all 8 binary
  targets (ALI-740).
- **Publishing happens when the RELEASE PR merges, not when you push a tag.** There is no
  `publish.yml` (this line used to name one): the `publish` job lives in
  `.github/workflows/release-please.yml`, is gated on
  `needs.release-please.outputs.releases_created == 'true'`, and runs typecheck, test and build before `npm publish --provenance --access public`.
  So the whole release is: land your work on `main`, then merge the `chore(main): release cli
  X.Y.Z` PR that release-please opens.
- **This package is 0.x, and `bump-minor-pre-major` is set** so a `BREAKING CHANGE:` footer
  bumps the MINOR (0.22 -> 0.23) instead of proposing 1.0.0. Without it, ALI-740's Node-floor
  bump silently retitled the open release PR to `release cli 1.0.0` - a promise about API
  stability made by a commit footer, on a package whose own README says "Beta, pre-1.0".
  `bump-patch-for-minor-pre-major` is deliberately NOT set: features should still bump the
  minor. Going to 1.0.0 is a decision someone makes, not a side effect. Do not publish manually, and do not hand-push a tag - the
  tag release-please creates is component-prefixed (`cli-v0.19.0`), so a `v*` trigger would not
  match it even if one existed. **Merging is not shipping:** verify with
  `npm view @aligndottech/cli version`, which lags the merge by a few minutes.
- `bin.align → ./dist/index.js`; `files: ["dist", "README.md"]`. Build with `npm run build` (tsc).
- **Running a local build:** `align` on PATH is the *globally installed* package, not your working tree. To test changes, run `node dist/index.js …` (after `npm run build`) or reinstall: `npm run build && npm pack && npm i -g ./aligndottech-cli-*.tgz --force`.

## Pre-push gate (before every PR)

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run
npm run build       # tsc -> dist/
```

## Connector auth model (context)

- **Cloud (default)** - connectors connect via **read-only browser OAuth** through the gateway (`oauthKey` on each `SetupSource`). Personal/CLI tokens are read-only; write scopes live only in the team/org bot apps.
- **Local (`--local`)** - fully offline/private; OAuth can't run (no hosted callback), so connectors use **manual read-only token paste** (`tokenLabel`/`tokenUrl`/`extraFields`). Teams/Zoom have no personal token → cloud-only.
- A connector with both `oauthKey` and token metadata uses OAuth in cloud and paste in local. The cloud collect loop checks `oauthKey` first, so token metadata is inert in cloud.

## Layout

```
src/
├── index.ts              # CLI entry (commander)
├── commands/             # setup, login, import/<connector>, ask, mcp, local, ...
│   └── setup.ts          # buildSources() connector defs + cloud/local onboarding
├── lib/
│   ├── fetchers/<x>.ts   # per-connector read-only fetchers (hit provider APIs)
│   ├── cli-oauth.ts      # browser OAuth callback (cloud)
│   ├── gateway-client.ts # cloud + local gateway clients
│   └── config.ts         # env/token store (Conf)
└── __tests__/            # vitest (setup.test.ts is the big one)
```

## No em-dashes

Use a regular hyphen or " - " in docs/comments, never the long dash.

<!-- align:start (managed by `align setup` - do not edit) -->
## Align decision graph

This project is connected to Align - the decision graph of what was decided, why, and by whom,
across Slack, Jira, GitHub, Linear and more (via the `align` MCP server).

- BEFORE writing or changing non-trivial code, check it against prior decisions
  (`align_check_alignment`, or run `align check`). A conflict means a past decision opposes
  the change - reconcile it or confirm with the user before proceeding.
- When unsure why something is the way it is, ask the graph first (`align_ask`).
- Claude Code hooks also surface conflicting decisions automatically: before an edit is
  written, and again after it lands.
<!-- align:end -->
