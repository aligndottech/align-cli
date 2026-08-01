# Research: Does the align CLI work with `pi` (the coding agent CLI)?

## Date
2026-08-02

## Goal
Establish whether `@aligndottech/cli`'s MCP server and setup flow work with **pi**, the
minimal coding agent by Mario Zechner. Specifically: which MCP clients `align setup` /
`align mcp --setup` target today, what transport the Align MCP server speaks, and what
would be needed to make pi a first-class target.

## Answer in one line

**Yes technically, no automatically.** `align mcp` is a plain stdio MCP server in exactly
the shape pi accepts, but `detectEditors()` has no pi target and pi does **not** read host
configs by default, so nothing wires itself up. Manual wiring is one JSON file.

## Provenance / method

- align-cli read at **`origin/main`** (`git show origin/main:<file>`), not the working tree -
  the local checkout was 9 commits behind (`5cbf841`, behind=9).
- npm facts from `registry.npmjs.org` directly, not from memory.
- pi facts from `pi.dev/packages/pi-mcp-adapter` and the `pi-mcp-adapter` README on npm.
- **pi is not installed on this machine** (`which pi` -> not found), so nothing below was
  executed end-to-end. This is a read of both sides' code/docs, not a live integration test.

## Key files

- `src/commands/mcp.ts:6,246` - `StdioServerTransport`. The Align MCP server is **stdio only**;
  there is no HTTP/SSE transport. Invocation is `align mcp` (+ `--env <name>`).
- `src/commands/mcp.ts:16-24` - `ALIGN_MCP_INSTRUCTIONS`, the server-level instructions block
  (ALI-120) that makes an agent reach for Align unprompted.
- `src/lib/mcp-setup.ts:11-16` - the four config `format`s: `mcpServers` (Claude Desktop/Code,
  Cursor, Windsurf, Gemini CLI), `vscode` (`servers`, needs `type: "stdio"`), `zed`
  (`context_servers`, needs `source: "custom"`), `codex` (TOML block).
- `src/lib/mcp-setup.ts:54-124` - `detectEditors()`. Eight targets, each detected by
  `existsSync` on a well-known dir: Claude Desktop, Claude Code (`~/.claude.json`), Cursor,
  Windsurf, VS Code, Zed, Codex, Gemini CLI. **No pi, and no project-local `.mcp.json`.**
- `src/lib/mcp-setup.ts:26-38` - `alignServerEntry()`, the per-format entry. The default arm
  emits `{ command: 'align', args: ['mcp'] }`.
- `src/lib/agent-rules.ts:5-12` - the deterministic layer (ALI-121): `.claude/settings.json`
  hook, `CLAUDE.md` nudge, **`AGENTS.md` nudge**, `.cursor/rules/align.md`.
- `src/lib/agent-rules.ts:32-63` - `writeClaudeCodeHook()`, the Pre/PostToolUse
  `align check --advisory` guardrail. Claude Code format only.

## Architecture insights

Align's agent integration is **two independent layers**, and pi inherits them unevenly:

| Layer | Mechanism | Works in pi? |
|---|---|---|
| Tools | stdio MCP server, `align mcp` | Yes, after manual config + adapter install |
| Proactive-use instructions | MCP server `instructions` field | Partially - see `directTools` below |
| Project context nudge | `AGENTS.md` managed block | **Yes, free.** pi loads `AGENTS.md` from cwd, parent dirs and `~/.pi/agent/` |
| Deterministic guardrail | `.claude/settings.json` Pre/PostToolUse hook | **No.** Claude Code only; pi has no hook equivalent |

So a pi user gets model-discretion alignment (MCP instructions + AGENTS.md) but loses the
hook layer that fires regardless of model. That is the same gap Cursor/Codex/Gemini already
have, not a pi-specific one.

### pi's MCP model (the part that changes the wiring)

- MCP is **not native**. It comes from a separate package: `pi install npm:pi-mcp-adapter`
  (`pi-mcp-adapter@2.17.0`).
- Config precedence (highest last):
  1. `~/.config/mcp/mcp.json` 2. `~/.agents/mcp.json` 3. `~/.agents/mcp/mcp.json`
  4. `<Pi agent dir>/mcp.json` (`~/.pi/agent/mcp.json`) 5. `.mcp.json` 6. `.pi/mcp.json`
- Shape is the standard `{"mcpServers": {...}}` with `command` / `args` / `env` / `cwd`,
  plus pi-only fields `lifecycle`, `idleTimeout`, `directTools`, `disabled`.
- **Host configs are NOT loaded automatically.** `settings.hostConfigDiscovery` defaults to
  `"off"`; `/mcp setup` or `pi-mcp-adapter init --discover-host-configs` opts in. This is why
  align's existing `~/.claude.json` / `~/.cursor/mcp.json` entries do nothing for pi.
- **The adapter proxies by default.** Its whole reason to exist is context economy: servers
  are surfaced behind one `mcp({search|tool|args})` tool (~200 tokens) rather than as N tool
  definitions. Align's ~9 tools are therefore *discoverable* but not *present* unless the
  entry sets `"directTools": true`.

## Existing patterns

Adding a target is a three-line change following the shape already in the file:

```ts
// detectEditors()
if (existsSync(path.join(home, '.pi'))) {
  found.push({ name: 'pi', configPath: path.join(home, '.pi', 'agent', 'mcp.json'), format: 'pi' });
}

// alignServerEntry()
case 'pi':
  return { command: 'align', args, directTools: true };
```

`jsonTopKey('pi')` falls through to `'mcpServers'` with no edit. `ensureDir()` already
`mkdir -p`s, which matters because `~/.pi/agent/` may not exist before pi's first run.

## Implementation recommendations

**To use it today (no code change):** write `.mcp.json` at the repo root, or
`~/.config/mcp/mcp.json` for every project:

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"], "directTools": true }
  }
}
```

then `pi install npm:pi-mcp-adapter` and restart pi. Add `"args": ["mcp", "--env", "preview"]`
to point at a non-prod gateway. Run `align setup` in the repo as well - its `AGENTS.md` block
is read by pi for free.

**To make it first-class:** add the `'pi'` format + target above. Worth pairing with a
`.mcp.json` project target, which is the tool-agnostic file pi, Claude Code and others all
read - one write covering several clients instead of one per host.

## Potential pitfalls

- **`directTools` is not cosmetic.** Without it the agent must call `mcp({search: "align"})`
  before it can call anything, which directly undercuts `ALIGN_MCP_INSTRUCTIONS`'s "call
  `align_check_alignment` BEFORE writing code". Verify how the adapter surfaces server-level
  `instructions` in proxy mode before claiming the proactive behaviour survives.
- **Two npm scopes for pi.** `@mariozechner/pi-coding-agent` is stale (0.73.1, last published
  2026-05-07); the live package is **`@earendil-works/pi-coding-agent`** (0.83.0, 2026-07-29).
  Both install a `pi` binary. Detection by `~/.pi` covers either.
- **`existsSync('~/.pi')` may be ambiguous.** Confirm pi actually creates `~/.pi` on first run
  (the adapter honours `$PI_CODING_AGENT_DIR`, so the dir is overridable). A detector keyed on
  a dir that only appears after `/mcp setup` would silently never fire.
- **The installed CLI here is 0.6.0; npm latest is 0.7.1.** 0.7.1 contains ALI-423, "back the
  MCP server with the local graph for a no-account user" - which is exactly the config a pi
  user trying Align for free would hit. Upgrade before testing.
- **nvm globals are per Node version** - `align --version` reported 0.6.0 under node
  v24.18.0 in align-stack; a different directory can resolve a different CLI.
- **The hook layer does not port.** Do not describe pi support as equivalent to Claude Code
  support; the deterministic `align check --advisory` guardrail has no pi equivalent today.
- **None of this was executed.** pi is not installed here, so treat the wiring above as
  derived-from-docs until someone runs it.

## Research completeness: 5/5
