# Align CLI

Capture decisions, check alignment, and query your decision graph from the terminal.

```
npm install -g @aligndottech/cli
```

Node 20+ required.

## Quick start

```bash
# 1. Log in (opens your browser to generate an API token)
align login

# 2. Populate your graph from local git history
align import git

# 3. Search decisions
align search "authentication strategy"

# 4. Browse recent decisions
align decisions list
```

That's it. No admin setup, no connectors required - `align import git` works anywhere you have a git repo.

## Authentication

```bash
align login                  # opens browser → paste token
align login --token algt_... # non-interactive, good for CI
align whoami                 # verify current session
align logout                 # clear stored credentials
```

Tokens are stored locally in your OS config directory. To create one manually, go to **Settings → API Tokens** in the Align web app.

## Importing decisions

Pull your existing work into the decision graph.

```bash
# Git commits (no credentials needed)
align import git
align import git --limit 200 --from 2024-01-01 --branch main
align import git --approve   # skip confirmation prompt

# Personal connectors (use your own credentials, no admin required)
align import github   --token ghp_...
align import gitlab   --token glpat-...
align import linear   --token lin_api_...
align import jira     --domain yourco.atlassian.net --email you@co.com --token ...
align import confluence --domain yourco.atlassian.net --email you@co.com --token ...
align import slack    --token xoxp-...
align import notion   --token secret_...
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
align search "why did we choose postgres"
align decisions list
align decisions list --space backend
align decisions get <id>
align links list                       # view decision relationships
align drift                            # decisions that may be out of date
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

Pass the token via `ALIGN_TOKEN` env var or `--token` flag.

## MCP server

Run Align as an MCP server so AI assistants (Claude, Cursor, etc.) can query your decision graph directly.

```bash
align mcp
```

Add to your MCP client config:

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

## Environments

By default the CLI targets `prod` (`api.align.tech`). Use `--env` or set a sticky default:

```bash
align env set preview          # stick to preview for this machine
align env get                  # show current default
align --env local <command>    # one-off override
```

## Environment variables

| Variable | Purpose |
|---|---|
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
