# Command reference

`(cloud)` marks commands that address the hosted gateway and aren't yet routed to a local graph.
See [local-mode.md](local-mode.md).

## Setup and auth

```
align setup                  Guided onboarding: connect tools, configure MCP + auto-alignment
align setup --local          Same, but no account: local SQLite graph
align login                  Authenticate with Align
align logout                 Remove stored credentials
align whoami                 Show current authenticated user and tenant
```

## Asking

```
align ask <query>            Ask a natural language question (or pass a file path)
align search <query>         Keyword/semantic search - returns a ranked list
align decisions list         List decisions in your graph
align decisions show <id>    Show full detail for a decision
align links list             Show cross-tool decision relationships (cloud)
align drift                  Show decisions that may be out of date (cloud)
align export                 Export decisions as a structured brief (cloud)
align spaces list            List spaces (project scopes) (cloud)
align status                 Value readout: what your graph has done for you
```

`ask`, `search` and `decisions list` take `--repo <name>` and `--all` in local mode - see
[local-mode.md](local-mode.md#how-the-local-graph-behaves). Without either, they default to
the repo you are standing in (plus anything not attributed to a repo), never to every repo
you have ever imported.

## Importing

```
align import git             Import from Git commit history (no auth)
align import docs            Import ADRs and your CLAUDE.md/AGENTS.md content (no auth)
align import github          Import from GitHub
align import gitlab          Import from GitLab
align import jira            Import from Jira
align import linear          Import from Linear
align import confluence      Import from Confluence
align import slack           Import from Slack (experimental)
align import teams           Import from Microsoft Teams
align import zoom            Import from Zoom recording transcripts
align import notion          Import from Notion
align capture <url>          Capture a decision from a URL (platform auto-detected)
align import --all           Start a connector scan across enabled connectors (cloud)
align import list            List scan jobs (cloud)
align import suggestions     Review scan suggestions (cloud)
align import scan-runs       Scan history (cloud)
```

## Checking

```
align check                  Check current changes against the decision graph
align adjudicate <event-id>  Answer a check that reached the judge and declined to rule (cloud)
```

## Agent wiring

```
align mcp                    Start local MCP server
align mcp --setup            Auto-configure editors to use Align as MCP server
align context sync           Write decisions to .align/decisions.md + CLAUDE.md import
```

## Local graph

```
align local start            Initialize a local decision graph
align local status           Show local graph statistics
align local reset            Wipe the local graph
```

## Environments

```
align env set <name>         Set default environment
align env get                Show current environment
```

## Telemetry

```
align telemetry on           Opt in to anonymous usage pings in local-only mode
align telemetry off          Opt out (also the default until you say yes)
align telemetry status       Show the effective state and why
```

See [Cloud or local-only](local-mode.md#telemetry) for what each mode actually sends.
