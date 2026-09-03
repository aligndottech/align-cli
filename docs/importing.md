# Importing decisions

Pull your existing work into the decision graph. The more sources you add, the richer the
cross-tool relationship detection.

## The easy way

```bash
align setup
```

It connects each source through a **read-only browser OAuth** consent, so there are no tokens
to create or paste. GitHub, Jira, Confluence, Slack, Microsoft Teams, Zoom, Linear, GitLab
(gitlab.com) and Notion all use OAuth. Self-managed GitLab uses a read-only token you paste.

The CLI only ever reads. It can't modify your tools; write access lives only in the team and
org bot apps.

The same OAuth flow works per source: `align import <source> --personal` opens the browser
consent, or reuses a token `align setup` already cached. The `--token` forms below are the
manual and CI alternative, and how you connect self-managed hosts.

Every import previews what it will import and asks before sending anything. Use `--approve` to
skip the prompt.

> **Local-only mode:** add `--env local` to every import. A machine that has also logged in to
> cloud otherwise imports to the cloud graph.

## Git

No auth needed. This is what `align setup` seeds from.

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

## Docs

No auth needed, same as Git. Reads ADR directories (`docs/adr`, `doc/adr`, `docs/decisions`,
`doc/decisions`, `adr/` - whichever convention your repo uses) and your own CLAUDE.md/AGENTS.md
content, split by section. It never re-imports what `align setup` already wrote into those files
(the managed nudge block and the `.align/decisions.md` import line) - that would be a feedback
loop, not a decision.

```bash
align import docs
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `500` | Max items to import |
| `--approve` | - | Skip confirmation prompt |

## GitHub and GitLab

```bash
align import github --token ghp_...
align import gitlab --token glpat-...   # self-managed: create a read_api (read-only) token
```

## Jira

```bash
align import jira \
  --token <your-jira-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

## Linear

OAuth scope is `read`.

```bash
align import linear --token lin_api_...
```

## Confluence

```bash
align import confluence \
  --token <your-confluence-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

## Slack (experimental)

OAuth uses read scopes only, no `chat:write`. The Slack app needs public distribution enabled,
or you authorize from its home workspace.

Manually, `align import slack` needs a Slack **user** token (`xoxp-...`), not a bot token. Go to
[api.slack.com/apps](https://api.slack.com/apps), create an app, and add these User Token Scopes
under OAuth & Permissions: `channels:read`, `channels:history`, `groups:read`, `groups:history`.
Install to your workspace and copy the OAuth User Token.

```bash
align import slack --token xoxp-<your-slack-user-token>
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `50` | Max threads to import |
| `--days-back` | `90` | How many days back to scan |

## Notion

Create an internal integration with **only "Read content"** capability, no insert or update,
then paste its secret:

```bash
align import notion --token <your-notion-integration-token>
```

## Microsoft Teams

In local mode, paste a Microsoft Graph access token: sign in to
[Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer), open the
"Access token" tab and copy it. Reading channel messages needs `ChannelMessage.Read.All`,
which your Microsoft 365 admin may have to consent to. The token expires after about an
hour, so re-run `align setup --local` and pick Teams to paste a fresh one when you want to
refresh. `align import teams --token <Graph token> --env local` imports once from the
command line without remembering the token; setup is what makes Teams show as connected.

## Zoom

Use `align setup` with a cloud account. Zoom has no personal token a human can create
in-app, so it isn't offered in local-only setup. `align import zoom --token <OAuth token>`
exists for a token you got elsewhere.

## Connector scans (cloud)

With a cloud account, the gateway can run connector-side scans and hold the results as
suggestions for review.

```bash
align import --all           # start a scan across every enabled connector
align import list            # scan jobs and their status
align import suggestions     # review what a scan found
align import scan-runs       # scan history
```

## Capturing one decision

```bash
align capture https://github.com/org/repo/pull/42
align capture https://yourco.atlassian.net/browse/ENG-123
align capture https://yourco.slack.com/archives/C123/p1700000000000000
```

The platform is detected from the URL. `align capture` takes a URL; raw text capture isn't
supported from the CLI yet. Over MCP, `align_capture` accepts text too, in local-only mode.

## Re-importing is safe

A decision is identified by its source URL and title, so running the same import twice updates
what changed rather than duplicating the graph.
