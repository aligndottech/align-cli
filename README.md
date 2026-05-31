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

Guided onboarding: login check, source selection, read-only OAuth connection, imports, AI provider setup, cross-tool relationship detection, and MCP configuration - all in one command.

Or step by step:

```bash
align login                              # authenticate
align setup                              # connect tools (read-only OAuth) + configure MCP
align import git                         # pull commit history - no token needed
align ask "how does our auth work"       # natural language answer from your graph
```

## Asking questions

`align ask` retrieves the most relevant decisions from your graph and synthesises a concise natural language answer:

```bash
align ask "why do we use postgres"
align ask "how does the auth module work"
align ask "what was decided about caching"
align ask "do we use redis"
```

Ask in plain English - the graph picks keyword or semantic search automatically based on your phrasing, so full questions ("why do we use postgres") work as well as short terms ("postgres").

### AI provider for align ask

`align ask` needs an AI model to synthesise answers. It tries the following in order:

1. Provider configured via `align config ai set` (stored locally)
2. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, or `MISTRAL_API_KEY` env vars
3. Ollama running locally (auto-detected)
4. Align's hosted AI (for users on a paid Align plan)
5. Formatted decision summaries (always works - no AI required)

**Note:** A Claude.ai or ChatGPT subscription is not the same as an API key. You need a separate API account. [Groq](https://console.groq.com/keys) offers a free tier with no credit card required and is the fastest option.

Configure a provider interactively:

```bash
align config ai set    # pick a provider and paste your key
align config ai        # show current provider
align config ai clear  # remove stored key
```

Or run `align setup` - it includes this step automatically.

## Authentication

```bash
align login                  # opens browser, paste token when prompted
align login --token algt_... # non-interactive, good for CI
align whoami                 # verify current session
align logout                 # clear stored credentials
```

Tokens are stored locally in your OS config directory. To create one manually, go to **Settings > API Tokens** in the Align web app.

## Cloud vs local mode

`align setup` offers two modes:

- **Personal cloud** (default) — your decision graph is hosted at Align: synced across machines, backed up, and upgradeable to a shared team workspace. Connectors connect via **read-only browser OAuth** (no tokens to paste), and `align ask` synthesis runs server-side. Nothing you connect can be modified by the CLI - it only reads.
- **Local-only** (`align setup --local`) — fully **private and offline**: no account, no cloud, nothing leaves your machine. The graph, embeddings, and search all live in a local database. Seeds from your git history out of the box; other sources connect by pasting a **read-only personal token** (OAuth needs the hosted callback, so it isn't available offline). Run `align local status` to inspect it, `align local reset` to wipe it.

Pick cloud for sync + team upgrade, local for maximum privacy. You can always start local and move to cloud later.

## Importing decisions

Pull your existing work into the decision graph. The more sources you add, the richer the cross-tool relationship detection.

**Easiest way: `align setup`.** It connects each source via a **read-only browser OAuth** consent - no tokens to create or paste. The CLI only ever *reads*; it can't modify your tools (write access lives only in the team/org bot apps). GitHub, Jira, Confluence, Slack, Microsoft Teams, Zoom, Linear, GitLab (gitlab.com), and Notion all use OAuth. Self-managed GitLab (a custom domain) uses a read-only token you paste.

The `align import <source> --token ...` forms below are the manual / CI alternative (and how to connect self-managed hosts).

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

Prefer `align setup` - GitHub and gitlab.com connect via read-only OAuth (no token to create). Manual / self-managed alternative:

```bash
align import github --token ghp_...     # or connect via `align setup` (read-only OAuth)
align import gitlab --token glpat-...    # self-managed GitLab: create a read_api (read-only) token
```

### Jira

```bash
align import jira \
  --token <your-jira-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

### Linear

Prefer `align setup` - Linear connects via read-only OAuth (scope `read`). Manual alternative:

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

Prefer `align setup` - Slack connects via read-only OAuth (read scopes only, no `chat:write`). Note: the Slack app must have public distribution enabled, or you authorize from its home workspace.

> **Manual alternative:** `align import slack` requires a Slack **user** token (`xoxp-...`), not a bot token.
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

Create an internal integration with **only "Read content"** capability (no insert/update), then paste its secret:

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
align ask "any question in plain English"  # natural language answer
align search "authentication strategy"     # keyword/semantic search - returns a list
align decisions list
align decisions list --space backend
align decisions show <id>
align links list                           # cross-tool decision relationships
align drift                                # decisions that may be out of date
```

`align ask` synthesises an answer. `align search` returns a ranked list - useful when you want to browse.

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
| `ANTHROPIC_API_KEY` | Anthropic API key for `align ask` synthesis |
| `OPENAI_API_KEY` | OpenAI API key for `align ask` synthesis |
| `GEMINI_API_KEY` | Google Gemini API key for `align ask` synthesis |
| `GROQ_API_KEY` | Groq API key for `align ask` synthesis |
| `MISTRAL_API_KEY` | Mistral API key for `align ask` synthesis |
| `OLLAMA_HOST` | Ollama host (default: `http://localhost:11434`) |

## Self-hosted

```bash
align login --env local --token algt_...
# or
ALIGN_GATEWAY_URL=https://api.yourco.com align decisions list
```

## Command reference

```
align setup                  Guided onboarding: connect tools, configure AI + MCP
align login                  Authenticate with Align
align logout                 Remove stored credentials
align whoami                 Show current authenticated user
align ask <question>         Ask a natural language question - get a synthesised answer
align search <query>         Keyword/semantic search - returns a ranked list
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
align config ai              Show configured AI provider
align config ai set          Configure an AI provider for align ask
align config ai clear        Remove stored AI provider
align mcp                    Start local MCP server
align mcp --setup            Auto-configure editors to use Align as MCP server
```
