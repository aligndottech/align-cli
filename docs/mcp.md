# MCP server

Run Align as a local [Model Context Protocol](https://modelcontextprotocol.io) server so AI
assistants can query your decision graph inline.

```bash
align mcp --setup   # auto-configure detected editors
align mcp           # start the server directly
```

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
