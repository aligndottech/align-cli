# Agent-agnostic MCP setup

Date: 2026-06-28
Branch: `tnk/agent-agnostic-mcp-setup`
Repo: `aligndottech/align-cli`

## Problem

`align setup` / `align mcp --setup` only understands three MCP clients: Claude Desktop,
Claude Code, and Cursor. If a developer uses any other agent (Windsurf, VS Code/Copilot,
Zed, OpenAI Codex CLI, Gemini CLI, ...) setup reports "No editors detected" and tells them
to "install Claude Code or Cursor". Align is meant to be agent-agnostic - any MCP-capable
agent should be a first-class setup target. The rules/nudge layer is also Claude+Cursor
only (`CLAUDE.md` + `.cursor/rules/align.md`), with no generic `AGENTS.md`.

## Current state (research)

- `src/lib/mcp-setup.ts`
  - `detectEditors()`: hardcodes Claude Desktop, Claude Code (`~/.claude.json`), Cursor
    (`~/.cursor`). `EditorTarget = { name, configPath, configKey }`.
  - `writeMcpConfig(target, env)`: JSON-merges `{ command:'align', args:['mcp', ...] }`
    under `target.configKey` (always `mcpServers`). Preserves other keys, throws on
    invalid JSON, idempotent on the `align` entry.
- `src/lib/agent-rules.ts`
  - `setupAgentAlignment()` writes `.claude/settings.json` (Pre/PostToolUse hook),
    `CLAUDE.md` (marker-delimited managed nudge), `.cursor/rules/align.md`.
- `src/commands/setup.ts`: Step 3 detects editors, multiselect when >1, writes MCP config;
  line ~648 "install Claude Code or Cursor" when none detected. Step 3b writes agent rules.
- `src/commands/mcp.ts`: `runMcpSetup()` multiselect over detected editors; already prints a
  generic manual snippet when none detected. Command/option descriptions name Claude/Cursor.

## Verified target formats (web-confirmed 2026-06-28)

| Agent | Config path | Shape |
|-------|-------------|-------|
| Claude Desktop | `<app support>/Claude/claude_desktop_config.json` | `mcpServers` + `{command,args}` |
| Claude Code | `~/.claude.json` | `mcpServers` + `{command,args}` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` + `{command,args}` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` + `{command,args}` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` + `{command,args}` |
| VS Code | `<userdir>/Code/User/mcp.json` | **`servers`** + `{type:'stdio',command,args}` |
| Zed | `~/.config/zed/settings.json` | **`context_servers`** + `{source:'custom',command,args}` (the `source:'custom'` field is REQUIRED - Zed silently drops entries without it) |
| Codex CLI | `~/.codex/config.toml` | **TOML** `[mcp_servers.align]` table |

VS Code User dir: macOS `~/Library/Application Support/Code/User`, Windows
`%APPDATA%/Code/User`, Linux `~/.config/Code/User`.

## Design

Introduce a `format` discriminator on `EditorTarget` and dispatch in `writeMcpConfig`.

```ts
type McpFormat = 'mcpServers' | 'vscode' | 'zed' | 'codex';
interface EditorTarget { name: string; configPath: string; format: McpFormat; }
```

- JSON formats (`mcpServers`, `vscode`, `zed`) share one merge helper that preserves
  existing keys, throws on invalid JSON, and is idempotent on the `align` entry. The
  top-level key and the entry shape vary by format:
  - `mcpServers` -> key `mcpServers`, entry `{ command, args }`
  - `vscode`     -> key `servers`,    entry `{ type:'stdio', command, args }`
  - `zed`        -> key `context_servers`, entry `{ source:'custom', command, args }`
- `codex` -> marker-delimited managed TOML block (mirrors the `CLAUDE.md` managed-block
  pattern; no TOML dependency added). Replace-between-markers if present, else append.

`detectEditors()` adds Windsurf, Gemini CLI, VS Code, Zed, Codex with the right
`format` + path. Order: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Zed,
Codex, Gemini CLI (familiar first).

### AGENTS.md (generic nudge)

- Generalize `managedNudgeBlock()` to `managedNudgeBlock({ claudeHooks })`. CLAUDE.md keeps
  the Claude-Code-hook bullet; AGENTS.md drops it.
- Extract `writeMarkerNudge(file, block)`; `writeManagedNudge` -> CLAUDE.md (claudeHooks:true),
  new `writeAgentsNudge` -> AGENTS.md (claudeHooks:false).
- `setupAgentAlignment()` now writes `.claude/settings.json`, `CLAUDE.md`, `AGENTS.md`,
  `.cursor/rules/align.md` and returns all four paths.

### Copy / fallback

- `setup.ts`: when no editors detected, print the portable MCP snippet and say "any
  MCP-capable agent" instead of "install Claude Code or Cursor".
- `mcp.ts`: command + `--setup` descriptions become agent-neutral.

## TDD phases

1. **mcp-setup multi-format** (RED first): `detectEditors` returns new targets given their
   dirs exist; `writeMcpConfig` writes the right key/entry per format (vscode `servers` +
   `type:stdio`; zed `context_servers` + `source:custom`; codex TOML block, idempotent,
   preserves other tables). Migrate existing tests from `configKey` -> `format`.
2. **AGENTS.md nudge** (RED first): `writeAgentsNudge` writes marker-delimited AGENTS.md
   without the Claude-hook line; `setupAgentAlignment` reports all four artifacts.
3. **Copy/fallback**: neutral wording + generic snippet (covered by existing setup tests +
   targeted assertions where practical).

## Validation

`pnpm test` (baseline 295 green), `pnpm run typecheck`, `pnpm run lint`. Manual: dry-read
the generated config snippets for each format.

## Out of scope

VS Code Insiders / VSCodium flavors; Continue/Cline deep-storage paths; auto-running
`code --add-mcp`. The generic snippet + AGENTS.md covers anything undetected.