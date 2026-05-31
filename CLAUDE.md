# Claude Code Setup for Align CLI

`@aligndottech/cli` — the open-source TypeScript CLI for Align (login, `setup`, connector imports, `ask`, MCP config). Companion to the closed `align-stack` gateway.

## Workflow (Research → Plan → Implement → Validate, mandatory TDD)

For any non-trivial change, follow the same harness as align-stack: understand the area, write a reviewable plan, then RED → GREEN → REFACTOR. See [.claude/rules/tdd.md](../align-stack/.claude/rules/tdd.md) in align-stack for the TDD cycle (test behaviors via the public API, mock only at module boundaries, never skip RED).

## Linear-Driven Workflow (always)

Every substantial change is tracked in Linear and traceable branch → ticket → PR (trivial typo fixes exempt):

1. **Ticket first** in the **Align** team (project **Align MVP**), label **`align-cli`**.
2. **Branch off latest `main`**, named **`tnk/ALI-<#>`** (e.g. `tnk/ALI-103`). One branch / one PR per ticket.
3. Reference the ticket id (**ALI-##**) in the PR title or body.
4. Linear MCP is configured in align-stack's `.mcp.json`; reconnect if its tools aren't available.

## Repo specifics (READ THIS)

- **Package manager: `npm`** (NOT pnpm). The lockfile is `package-lock.json`. Use `npm install` / `npm ci` — do not introduce `pnpm-lock.yaml`.
- **Node ≥ 20** (CI uses Node 20).
- **Publishing is gated on a git tag:** pushing a `v*` tag triggers `.github/workflows/publish.yml` → `npm publish --provenance --access public`. Do not publish manually; bump the version and push a tag.
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

- **Cloud (default)** — connectors connect via **read-only browser OAuth** through the gateway (`oauthKey` on each `SetupSource`). Personal/CLI tokens are read-only; write scopes live only in the team/org bot apps.
- **Local (`--local`)** — fully offline/private; OAuth can't run (no hosted callback), so connectors use **manual read-only token paste** (`tokenLabel`/`tokenUrl`/`extraFields`). Teams/Zoom have no personal token → cloud-only.
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
