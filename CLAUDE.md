# Align CLI - Claude harness

The open-source Align CLI + MCP server (`@aligndottech/cli`). TDD is mandatory: write the failing test first.

## Linear-Driven Workflow (always)

Every new **substantial** piece of work is tracked in Linear and traceable from branch → ticket → PR. (Trivial fixes/typos are exempt.)

1. **Ticket first.** Before starting, create a Linear ticket in the **Align** team (project **Align MVP** unless told otherwise).
2. **Repo label.** Apply the **`align-cli`** label.
3. **Branch.** Branch off **latest `main`**, named **`tnk/ALI-<ticket#>`** (e.g. `tnk/ALI-42`). One branch / one PR per ticket.
4. **Reference.** Put the ticket id (**ALI-##**) in the PR title or body.
5. **Stay connected.** The Linear MCP server is configured in `.mcp.json`; reconnect if Linear tools aren't available.

Break a large effort into a parent ticket + sub-issues, each with its own `tnk/ALI-##` branch/PR.

## Repo notes

- Package manager: `npm` (CI runs `npm ci`; lockfile is `package-lock.json` - keep it in sync when adding deps). No `pnpm-lock.yaml`.
- Before pushing: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- Publish to npm is gated on a `v*` tag (not main pushes).
