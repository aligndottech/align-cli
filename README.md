# Align CLI

[![npm version](https://img.shields.io/npm/v/@aligndottech/cli.svg)](https://www.npmjs.com/package/@aligndottech/cli)
[![CI](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/@aligndottech/cli.svg)](https://nodejs.org)

**AI agents are shipping code from decisions they can't see.**

[Align](https://align.tech) captures the reasoning behind every engineering choice - across Git, GitHub, GitLab, Jira, Confluence, Linear, Slack, Microsoft Teams, Zoom, and Notion - links them into a cross-tool decision graph, and surfaces that context to every agent and engineer on your team.

The CLI lets you import your decision history, query it in plain English, and run Align as a local [MCP](https://modelcontextprotocol.io) server so your AI assistants have authoritative context inline - and check their changes against it automatically.

```
npm install -g @aligndottech/cli
```

Node 20+ required. MIT licensed.

## Quick start

```bash
align setup
```

One guided command: login (or local-only mode), connect your tools via read-only OAuth, seed the graph from your git history, configure your editors' MCP, and wire up automatic alignment checks for AI agents.

Or step by step:

```bash
align login                              # authenticate
align setup                              # connect tools (read-only OAuth) + configure MCP
align import git                         # pull commit history - no token needed
align ask "how does our auth work"       # natural language answer from your graph
```

## How it works

```
  Your tools                      Align                       Your agents & you
  ──────────                   ───────────                  ───────────────────
  Git, GitHub, GitLab  ─┐                                  ┌─ align ask "why…"
  Jira, Confluence      ├─▶  import  ─▶  decision graph ─┐ ├─ MCP server (inline)
  Linear, Notion        │    (read-only) (what/why/who)  ├─┤  PostToolUse hook
  Slack, Teams, Zoom   ─┘                  + relationships┘ └─ align check (CI)
```

1. **Import** pulls the decisions out of the tools you already use - read-only, nothing is modified.
2. Align links them into a **cross-tool decision graph**: what was decided, why, who decided it, and how decisions relate (supersedes, conflicts with, depends on).
3. Your agents and you **query and check against** that graph - over MCP, a Claude Code hook, CI, or plain `align ask`.

The CLI and MCP server are open source (this repo). The hosted graph + relationship detection is a separate commercial gateway; you can also run fully local with `--local`.

## Auto-alignment for AI agents

When you run `align setup`, Align makes itself available to your AI agents three ways, so the context fires whether or not the model thinks to ask for it:

1. **MCP server** - your assistant (Claude Code, Cursor, Claude Desktop, Windsurf) can query the decision graph inline. The server ships with instructions telling the agent to check alignment *before* making non-trivial changes.
2. **Claude Code hook** - setup writes a `PostToolUse` hook (matcher `Write|Edit`) into the project's `.claude/settings.json`. After the agent edits a file, the hook runs `align check --advisory` and injects any conflicting decisions straight into the agent's context. It is **non-blocking and fail-open**: it never denies an edit, and if Align is slow or unreachable it exits silently.
3. **Editor rules** - a managed, marker-delimited block in your `CLAUDE.md` and a `.cursor/rules/align.md` file (Cursor doesn't honor Claude Code hooks) nudge agents to consult the graph.

The hook and rule files are committed to the repo, so the whole team's agents get the same guardrail. Re-running `align setup` updates them in place (idempotent - no duplicate hooks or blocks).

> **Heads up:** the first time Claude Code loads a project with a committed hook, it shows a one-time "approve hooks" prompt. Accept it to enable automatic alignment.

You can also run the advisory check yourself - it always exits 0 and prints the Claude Code hook JSON on a conflict:

```bash
align check --advisory
```

## Asking questions

`align ask` retrieves the most relevant decisions from your graph and synthesises a concise natural language answer:

```bash
align ask "why do we use postgres"
align ask "how does the auth module work"
align ask "what was decided about caching"
align ask "do we use redis"
```

Ask in plain English - the graph picks keyword or semantic search automatically based on your phrasing, so full questions ("why do we use postgres") work as well as short terms ("postgres"). Pass a file path instead of a question to find decisions related to that file:

```bash
align ask src/auth/session.ts
```

### AI provider for conversational answers

To synthesise a conversational answer, `align ask` uses **your own AI provider**. It looks, in order, for:

1. An API key in the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `GROQ_API_KEY`, or `MISTRAL_API_KEY`.
2. [Ollama](https://ollama.com) running locally (auto-detected on `localhost:11434`).

If none is available, `align ask` still works - it prints a ranked list of the matching decisions instead of a synthesised paragraph. No key is ever required.

**Note:** A Claude.ai or ChatGPT subscription is not the same as an API key - you need a separate API account. [Groq](https://console.groq.com/keys) offers a free tier with no credit card and is the fastest option.

The retrieval itself (search over your graph) always runs against Align - the API key is only used locally to phrase the answer.

## Authentication

```bash
align login                  # opens browser, paste token when prompted
align login --token algt_...  # non-interactive, good for CI / self-hosted
align whoami                 # verify current session
align logout                 # clear stored credentials
```

Tokens are stored locally in your OS config directory. To create one manually, go to **Settings > API Tokens** in the Align web app.

## Cloud vs local mode

`align setup` offers two modes:

- **Personal cloud** (default) - your decision graph is hosted at Align: synced across machines, backed up, and upgradeable to a shared team workspace. Connectors connect via **read-only browser OAuth** (no tokens to paste), and `align ask` retrieval runs server-side. Nothing you connect can be modified by the CLI - it only reads.
- **Local-only** (`align setup --local`) - fully **private and offline**: no account, no cloud, nothing leaves your machine. The graph, embeddings, and search all live in a local database. Seeds from your git history out of the box; other sources connect by pasting a **read-only personal token** (OAuth needs the hosted callback, so it isn't available offline). Run `align local status` to inspect it, `align local reset` to wipe it.

Pick cloud for sync + team upgrade, local for maximum privacy. You can always start local and move to cloud later.

## Importing decisions

Pull your existing work into the decision graph. The more sources you add, the richer the cross-tool relationship detection.

**Easiest way: `align setup`.** It connects each source via a **read-only browser OAuth** consent - no tokens to create or paste. The CLI only ever *reads*; it can't modify your tools (write access lives only in the team/org bot apps). GitHub, Jira, Confluence, Slack, Microsoft Teams, Zoom, Linear, GitLab (gitlab.com), and Notion all use OAuth. Self-managed GitLab (a custom domain) uses a read-only token you paste.

The `align import <source> --token ...` forms below are the manual / CI alternative (and how to connect self-managed hosts). Every import previews what will be imported and asks for confirmation before sending anything (use `--approve` to skip the prompt).

### Git

```bash
align import git
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `500` | Max commits to import |
| `--branch` | current branch | Git branch to scan |
| `--from` | - | Start date (ISO, e.g. `2025-01-01`) |
| `--to` | - | End date (ISO) |
| `--approve` | - | Skip confirmation prompt |

### GitHub / GitLab

Prefer `align setup` - GitHub and gitlab.com connect via read-only OAuth (no token to create). Manual / self-managed alternative:

```bash
align import github --token ghp_...      # or connect via `align setup` (read-only OAuth)
align import gitlab --token glpat-...     # self-managed GitLab: create a read_api (read-only) token
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

### Microsoft Teams / Zoom

Connect these through `align setup` (OAuth) - they have no read-only personal token to paste, so they are cloud-only.

## Capturing decisions

```bash
# Capture a decision from a URL - the platform is detected automatically
align capture https://github.com/org/repo/pull/42
align capture https://yourco.atlassian.net/browse/ENG-123
align capture https://yourco.slack.com/archives/C123/p1700000000000000
```

## Searching and browsing

```bash
align ask "any question in plain English"  # natural language answer
align search "authentication strategy"      # keyword/semantic search - returns a list
align decisions list                        # browse the graph
align decisions list --space backend        # filter by space
align decisions list --platform jira        # filter by source platform
align decisions show <id>                   # full detail for one decision
align links list                            # cross-tool decision relationships
align drift                                 # decisions that may be out of date
align export                                # export decisions as a structured brief
```

`align ask` synthesises an answer. `align search` returns a ranked list - useful when you want to browse.

## Alignment check

Check your current changes against the decision graph. Exit code `1` means a conflict was found.

```bash
align check          # check the staged diff
align check --all    # check the full working-tree diff vs HEAD
```

Modes:

| Mode | Behavior |
|------|----------|
| (default) | Human-readable output; exits `1` on any conflict. |
| `--hook` | Pre-commit mode: silent when there's no context, only fails on **critical** conflicts. |
| `--advisory` | PostToolUse hook mode: **always exits 0**, emits conflicting decisions as Claude Code `additionalContext` JSON. Fail-open. |
| `--ci` | Emits JSON to stdout for CI; exits `1` on conflict. |

In CI:

```yaml
- name: Check alignment
  run: align check --all --ci
  env:
    ALIGN_TOKEN: ${{ secrets.ALIGN_TOKEN }}
```

Resolve a flagged conflict (records the resolution so it stops surfacing):

```bash
align check --resolve <decision_id>:honored      # or overridden | context_changed
```

## MCP server

Run Align as a local [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants (Claude Code, Claude Desktop, Cursor, Windsurf) can query your decision graph inline.

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

Once configured, your assistant can call these tools to query and update your decision graph in context:

| Tool | Purpose |
|------|---------|
| `align_ask` | Natural-language question about past decisions |
| `align_search` | Search the decision graph |
| `align_capture` | Capture a decision from a URL or text |
| `align_check_alignment` | Check a proposed change for conflicts with prior decisions |
| `align_check_drift` | Check whether code/config has drifted from a decision |
| `align_get_related_decisions` | Decisions related to a file or module |
| `align_get_conflicts` | Active conflicts in the graph |
| `align_get_impact` | Upstream/downstream impact of a decision |

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

Advanced: override the model per provider with `ALIGN_ANTHROPIC_MODEL`, `ALIGN_OPENAI_MODEL`, `ALIGN_GEMINI_MODEL`, `ALIGN_GROQ_MODEL`, or `ALIGN_MISTRAL_MODEL`.

## Self-hosted

```bash
align login --env local --token algt_...
# or
ALIGN_GATEWAY_URL=https://api.yourco.com align decisions list
```

## Command reference

```
align setup                  Guided onboarding: connect tools, configure MCP + auto-alignment
align login                  Authenticate with Align
align logout                 Remove stored credentials
align whoami                 Show current authenticated user and tenant
align ask <query>            Ask a natural language question (or pass a file path)
align search <query>         Keyword/semantic search - returns a ranked list
align capture <url>          Capture a decision from a URL (platform auto-detected)
align check                  Check current changes against the decision graph
align import git             Import from Git commit history (no auth)
align import github          Import from GitHub
align import gitlab          Import from GitLab
align import jira            Import from Jira
align import linear          Import from Linear
align import confluence      Import from Confluence
align import slack           Import from Slack (experimental)
align import teams           Import from Microsoft Teams
align import zoom            Import from Zoom recording transcripts
align import notion          Import from Notion
align decisions list         List decisions in your graph
align decisions show <id>    Show full detail for a decision
align export                 Export decisions as a structured brief
align drift                  Show decisions that may be out of date
align links list             Show cross-tool decision relationships
align spaces list            List spaces (project scopes)
align env set <name>         Set default environment
align env get                Show current environment
align mcp                    Start local MCP server
align mcp --setup            Auto-configure editors to use Align as MCP server
align local start            Initialize a local decision graph
align local status           Show local graph statistics
align local reset            Wipe the local graph
```

## License

MIT - see [LICENSE](./LICENSE). The CLI and MCP server are open source; the hosted gateway is a separate commercial service.
