# Align CLI

**AI agents are shipping code from decisions they can't see.**

[Align](https://align.tech) is the decision graph that gives every agent and every engineer the same source of truth. Decisions get made across the tools your team already uses - then disappear. Align captures them, links them across tools, and surfaces conflicts and changes in direction in real time.

Agents are probabilistic by design. Their outputs are only as reliable as the inputs they get. Code, docs, and APIs already feed in as structured context. The reasoning behind every engineering choice does not. Align is the deterministic decision layer upstream of every agent in your stack.

The CLI lets you import your decision history, ask questions about it in plain English, and run Align as a local MCP server - so your AI assistants have authoritative context inline. Think of it as `CLAUDE.md` for your whole org.

```
npm install -g @aligndottech/cli
```

Node 20+ required.

## Quick start

The fastest way to go from zero to a populated decision graph:

```bash
# Guided setup: connects your tools, imports decisions, configures MCP in one flow
align setup
```

Or step by step:

```bash
# 1. Log in (opens your browser to generate an API token)
align login

# 2. Import from your git history - no token needed
align import git

# 3. Ask questions in plain English
align why "why do we use postgres"
align why "how does our auth work"

# 4. Add more sources for cross-tool context
align import linear --token lin_api_...
align import jira --email you@co.com --token atl_... --domain co.atlassian.net
```

## The `align why` command

Ask any question about your codebase and get answers from your decision graph:

```bash
align why "why do we use postgres"
align why "how does the auth module work"
align why "what was decided about caching"
align why "do we use redis"
```

Question prefixes like "why", "how does", "what is", "do we" are normalised automatically - `align why "do we use postgres"` and `align why "use postgres"` return the same results.

The richer your graph (more sources imported), the better the answers.

## Setup wizard

```bash
align setup
```

Walks through: login check, source selection, token collection, imports, cross-tool relationship detection, and MCP configuration - all in one command. Takes about 10 minutes.

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
align why "any question in plain English"  # natural language Q&A over your graph
align search "authentication strategy"     # keyword/semantic search
align decisions list
align decisions list --space backend
align decisions get <id>
align links list                           # view cross-tool decision relationships
align drift                                # decisions that may be out of date
```

## CI alignment check

```bash
align check                    # check staged diff against decision graph
align check --branch main      # check current branch vs main
```

Returns exit code 1 when alignment issues are found, making it easy to fail a pipeline step.

Example GitHub Actions step:

```yaml
- name: Check alignment
  run: align check --branch ${{ github.base_ref }}
  env:
    ALIGN_TOKEN: ${{ secrets.ALIGN_TOKEN }}
```

## MCP server

Run Align as a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server so AI assistants (Claude, Cursor, Windsurf, etc.) can query your decision graph directly.

```bash
# Auto-configure detected editors (Claude Desktop, Claude Code, Cursor)
align mcp --setup

# Or start the server directly
align mcp
```

### Manual configuration

**Claude Desktop** - add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

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

**Claude Code** - add to `~/.claude.json` or your workspace `.mcp.json`:

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"] }
  }
}
```

**Cursor** - add to `~/.cursor/mcp.json`.

Once configured, your AI assistant can call tools including `align_search`, `align_ask`, `align_capture`, `align_check_drift`, and `align_get_related_decisions` to query and update your decision graph in context.

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

Point the CLI at your own instance:

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
align why <question>         Ask a natural language question about your graph
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
