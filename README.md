# Align CLI

**AI agents are shipping code from decisions they can't see.**

[Align](https://align.tech) captures the reasoning behind every engineering choice - across Git, Jira, Linear, Slack, Notion, Confluence, GitHub, and GitLab - links them into a decision graph, and surfaces that context to every agent and engineer on your team.

The CLI lets you import your decision history, query it in plain English, and run Align as a local MCP server so your AI assistants have authoritative context inline.

```
npm install -g @aligndottech/cli
```

Node 20+ required.

## Quick start

```bash
align setup
```

Guided onboarding: login check, source selection, token collection, imports, cross-tool relationship detection, and MCP configuration - all in one command.

Or step by step:

```bash
align login                              # authenticate
align import git                         # pull commit history - no token needed
align ask "how does our auth work"       # query your graph in plain English
align import linear --token lin_api_...  # add more sources for richer context
```

## Querying your graph

```bash
align ask "why do we use postgres"
align ask "how does the auth module work"
align ask "what was decided about caching"
align ask "do we use redis"
```

Question prefixes are normalised automatically - `align ask "do we use postgres"` and `align ask "use postgres"` return the same results. The richer your graph (more sources imported), the better the answers.

## Authentication

```bash
align login                  # opens browser, paste token when prompted
align login --token algt_... # non-interactive, good for CI
align whoami                 # verify current session
align logout                 # clear stored credentials
```

Tokens are stored locally in your OS config directory. To create one manually, go to **Settings > API Tokens** in the Align web app.

## Importing decisions

Pull your existing work into the decision graph. The more sources you add, the richer the cross-tool relationship detection.

### Git

```bash
align import git
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `100` | Max commits to import |
| `--branch` | current branch | Git branch to scan |
| `--from` | - | Start date (ISO, e.g. `2025-01-01`) |
| `--to` | - | End date (ISO) |
| `--approve` | - | Skip confirmation prompt |

### GitHub / GitLab

```bash
align import github --token ghp_...
align import gitlab --token glpat-...
```

### Jira

```bash
align import jira \
  --token <your-jira-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

### Linear

```bash
align import linear --token lin_api_...
```

### Confluence

```bash
align import confluence \
  --token <your-confluence-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

### Slack (experimental)

> **Note:** `align import slack` requires a Slack **user** token (`xoxp-...`), not a bot token.
>
> To get one: go to [api.slack.com/apps](https://api.slack.com/apps), create an app, add these User Token Scopes under OAuth & Permissions: `channels:read`, `channels:history`, `groups:read`, `groups:history`. Install to your workspace and copy the OAuth User Token.

```bash
align import slack --token xoxp-<your-slack-user-token>
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `50` | Max threads to import |
| `--days-back` | `90` | How many days back to scan |

### Notion

```bash
align import notion --token <your-notion-integration-token>
```

All import commands preview what will be imported and ask for confirmation before sending anything.

## Capturing decisions

```bash
# Capture a URL (Slack thread, GitHub PR, Jira ticket, ...)
align capture https://github.com/org/repo/pull/42

# Capture with explicit platform
align capture https://yourco.atlassian.net/browse/ENG-123 --platform jira
```

## Searching and browsing

```bash
align ask "any question in plain English"  # natural language Q&A
align search "authentication strategy"     # keyword/semantic search
align decisions list
align decisions list --space backend
align decisions show <id>
align links list                           # cross-tool decision relationships
align drift                                # decisions that may be out of date
```

## CI alignment check

```bash
align check                    # check staged diff against decision graph
align check --branch main      # check current branch vs main
```

Returns exit code 1 when alignment issues are found.

```yaml
- name: Check alignment
  run: align check --branch ${{ github.base_ref }}
  env:
    ALIGN_TOKEN: ${{ secrets.ALIGN_TOKEN }}
```

## MCP server

Run Align as a local [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants (Claude, Cursor, Windsurf) can query your decision graph inline.

```bash
align mcp --setup   # auto-configure detected editors
align mcp           # start the server directly
```

### Manual configuration

**Claude Desktop** - `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

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

**Cursor** - `~/.cursor/mcp.json` (same format as Claude Code above).

Once configured, your AI assistant can call `align_search`, `align_ask`, `align_capture`, `align_check_drift`, and `align_get_related_decisions` to query and update your decision graph in context.

## Environments

By default the CLI targets `prod` (`api.align.tech`). Use `--env` or set a sticky default:

```bash
align env set preview          # stick to preview for this machine
align env get                  # show current default
align --env local <command>    # one-off override
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALIGN_TOKEN` | API token (alternative to `align login`) |
| `ALIGN_ENV` | Default environment (`prod`, `preview`, `local`) |
| `ALIGN_GATEWAY_URL` | Override gateway URL (self-hosted) |
| `ALIGN_TENANT_ID` | Override tenant ID (self-hosted / CI) |

## Self-hosted

```bash
align login --env local --token algt_...
# or
ALIGN_GATEWAY_URL=https://api.yourco.com align decisions list
```

## Command reference

```
align setup                  Guided onboarding: connect tools and configure MCP
align login                  Authenticate with Align
align logout                 Remove stored credentials
align whoami                 Show current authenticated user
align ask <question>         Ask a natural language question about your graph
align search <query>         Keyword/semantic search across decisions
align capture                Capture a decision from a URL
align check                  Check alignment against existing decisions
align import git             Import from Git commit history
align import github          Import from GitHub
align import gitlab          Import from GitLab
align import jira            Import from Jira
align import linear          Import from Linear
align import confluence      Import from Confluence
align import slack           Import from Slack (experimental)
align import notion          Import from Notion
align decisions list         List decisions in your graph
align drift                  Show decisions that may be out of date
align links list             Show cross-tool decision relationships
align spaces                 Manage decision spaces
align env set <name>         Set default environment
align env get                Show current environment
align mcp                    Start local MCP server
align mcp --setup            Auto-configure editors to use Align as MCP server
```
