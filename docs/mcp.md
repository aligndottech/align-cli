# MCP server

Run Align as a local [Model Context Protocol](https://modelcontextprotocol.io) server so AI
assistants can query your decision graph inline.

```bash
align mcp --setup   # auto-configure detected editors
align mcp           # start the server directly
```

`--setup` writes a config for every client it finds on this machine: Claude Desktop, Claude
Code, Cursor, VS Code, Windsurf, Zed, Codex, GitHub Copilot CLI, Gemini CLI and pi. It writes
nothing for a client it does not find, and `align mcp --remove` takes the entry out again.
JetBrains IDEs are not detected, and there is a section for them below.

## Tools your assistant gets

| Tool | Purpose |
|------|---------|
| `align_ask` | Natural-language question about past decisions |
| `align_search` | Search the decision graph |
| `align_capture` | Capture a decision from a URL (raw text too, in local-only mode) |
| `align_check_alignment` | Check a proposed change for conflicts with prior decisions |
| `align_check_drift` | Check whether code or config has drifted from a decision |
| `align_get_related_decisions` | Decisions related to a file or module |
| `align_get_conflicts` | Active conflicts in the graph |
| `align_get_impact` | Upstream and downstream impact of a decision |

## Manual configuration

`align mcp --setup` writes these for you. Here they are if you'd rather do it by hand.

**Claude Desktop** - `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "align": {
      "command": "align",
      "args": ["mcp"],
      "env": { "ALIGN_TOKEN": "algt_..." }
    }
  }
}
```

**Claude Code** - `~/.claude.json` or your workspace `.mcp.json`:

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"] }
  }
}
```

**Cursor** - `~/.cursor/mcp.json`, same format as Claude Code above.

**VS Code (Copilot Chat)** - the user-profile `mcp.json`. `align mcp --setup` writes this one
for you when the VS Code user directory exists:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Code/User/mcp.json` |
| Linux | `~/.config/Code/User/mcp.json` |
| Windows | `%APPDATA%\Code\User\mcp.json` |

VS Code's top-level key is `servers`, not `mcpServers`, and the entry needs a `type`:

```json
{
  "servers": {
    "align": {
      "type": "stdio",
      "command": "align",
      "args": ["mcp"]
    }
  }
}
```

Run `align mcp --setup --env local` instead and the args are `["mcp", "--env", "local"]`.
Reload the VS Code window afterwards, then open Copilot Chat in agent mode and look for
`align` in its tools picker.

**What Copilot gets, and what it does not.** Copilot Chat can call every tool in the table
above, and it reads the managed block `align setup` writes into `CLAUDE.md` and `AGENTS.md`.
It does **not** get the deterministic pre-edit check, because VS Code exposes no hook API for
the CLI to write to. The model decides whether to look, on every edit.
[Agent hooks](agent-hooks.md) is the per-host matrix.

GitHub Copilot CLI is a different client with a different file, `~/.copilot/mcp-config.json`,
and `align mcp --setup` writes that one too. It does get a pre-edit hook.

**pi** - MCP isn't built in. Install the adapter first with `pi install npm:pi-mcp-adapter`,
then restart pi. `align setup` writes `~/.pi/agent/mcp.json`, or `$PI_CODING_AGENT_DIR/mcp.json`:

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"], "directTools": true }
  }
}
```

`directTools` matters. The adapter is lazy by default and hides every server behind a single
proxy tool the agent has to search first, which defeats the "check alignment *before* the edit"
instruction.

## JetBrains IDEs: Rider, IntelliJ IDEA and the rest

`align mcp --setup` does not detect or write any JetBrains configuration. You wire it by hand,
and the shape is the ordinary one.

**JetBrains AI Assistant** is an MCP client and launches a stdio server as a subprocess.
JetBrains documents the config as `mcpServers` with `command` and `args`, which is the same
shape as the Claude Code block above:

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"] }
  }
}
```

Paste that into `Settings | Tools | AI Assistant | Model Context Protocol (MCP)`. JetBrains
publishes no file path for that setting, so there is nothing for a CLI to write. If you already
run Claude Desktop with Align wired, the same dialog offers an **Import from Claude** button
that reuses the configuration `align mcp --setup` put there.

**Junie CLI** does read a file: `~/.junie/mcp/mcp.json` for every project, or
`.junie/mcp/mcp.json` inside one. Same `mcpServers` shape, and no `type` field.

Separate questions, because the answers differ:

| | |
|---|---|
| Do JetBrains AI Assistant and Junie CLI support stdio MCP servers | Yes, per JetBrains' own documentation |
| Does `align mcp --setup` write either config | No. Nothing in this repo names JetBrains, Rider, IntelliJ or Junie |
| Has Align been run inside a JetBrains IDE | **Not verified.** No JetBrains IDE was available to test against |

The two config blocks above come from JetBrains documentation read on 2026-09-21
([AI Assistant](https://www.jetbrains.com/help/ai-assistant/configure-an-mcp-server.html),
[Junie](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html)), and not from a
session anyone watched work. **Not verified** is the honest state here, and it is a different
claim from *not supported*. If you run Align in Rider, please tell us what happened.

On hooks, JetBrains AI Assistant is in the same position as VS Code: MCP tools and the
`AGENTS.md` nudge, and no deterministic pre-edit check. **Junie CLI is not**, and the first
draft of this page said it was. Junie CLI documents a `PreToolUse` hook that can block a tool
call and can hand the model extra context, so the reason Align has no pre-edit check there is
that nothing writes the file, and not that the host cannot do it.
[Agent hooks](agent-hooks.md) carries the detail.

Do not confuse either of the above with the **JetBrains MCP Server** plugin, which points the
other way. That one turns the IDE into a server other clients call, and it has nothing to do
with reading your decision graph.
