# Importing decisions

Pull your existing work into the decision graph. The more sources you add, the richer the
cross-tool relationship detection.

## The easy way

```bash
align login     # team graph only; a solo setup is local and needs no login
align
```

On a team graph, setup connects each source through a **read-only browser OAuth** consent, so
there are no tokens to create or paste. The solo (local) wizard that bare `align` runs has no
OAuth callback to receive, so it asks you to paste a read-only token for each source instead. GitHub, Jira, Confluence, Slack, Microsoft Teams, Zoom, Linear, GitLab
(gitlab.com) and Notion all use OAuth. Self-managed GitLab uses a read-only token you paste.

The CLI only ever reads. It can't modify your tools; write access lives only in the team and
org bot apps.

> `align import` was renamed `align connect` in 0.40.0. The old spelling now exits 2 and
> names the replacement; it was deprecated in 0.38.0 with a line on every run.

The same OAuth flow works per source: `align connect <source> --personal` opens the browser
consent, or reuses a token `align` already cached. The `--token` forms below are the
manual and CI alternative, and how you connect self-managed hosts.

Every import previews what it will import and asks before sending anything. Use `--approve` to
skip the prompt.

## Local mode tokens: where they live, and how to supply them

Local mode (`align --local`) has no OAuth callback, so each source uses a read-only token you create and paste. Zoom is not in this list: it has no personal token, so it is a cloud-only source.

**Where a pasted token is stored.** In your operating system's credential store when there is one:

| OS | Store | Tool Align runs |
|---|---|---|
| macOS | Keychain | `/usr/bin/security` |
| Linux | Secret Service (GNOME Keyring, KWallet) | `secret-tool` (package `libsecret-tools`) |
| Windows | DPAPI: encrypted for your Windows account, blob kept in `token-blobs.json` beside `config.json` | PowerShell |

The token goes to the tool on stdin, never on its command line, so it does not show up in `ps`. Align reads each write back before it counts it.

**The fallback.** With no credential store (a headless Linux box with no secret service, a missing tool, an error), Align saves the token in `config.json` (owner-only, `0600`) and says so once: which store it could not use and why. `align doctor` reports which store is in use. `ALIGN_TOKEN_STORE=file` chooses the file on purpose and prints nothing.

**Tokens saved by an older version** move into the credential store the next time Align reads them, and the plaintext copy is removed only after the store holds it. If the move fails, the token stays readable in the file. `align local forget <source>` removes the token from the credential store as well, and says so if it could not.

**From your environment or a password manager.** Set `ALIGN_<SOURCE>_TOKEN`:

| Source | Variable | Extra variables |
|---|---|---|
| GitHub | `ALIGN_GITHUB_TOKEN` | |
| GitLab | `ALIGN_GITLAB_TOKEN` | `ALIGN_GITLAB_DOMAIN` (self-managed) |
| Jira | `ALIGN_JIRA_TOKEN` | `ALIGN_JIRA_EMAIL`, `ALIGN_JIRA_DOMAIN` |
| Confluence | `ALIGN_CONFLUENCE_TOKEN` | `ALIGN_CONFLUENCE_EMAIL`, `ALIGN_CONFLUENCE_DOMAIN` |
| Slack | `ALIGN_SLACK_TOKEN` | |
| Linear | `ALIGN_LINEAR_TOKEN` | |
| Notion | `ALIGN_NOTION_TOKEN` | |
| Teams | `ALIGN_TEAMS_TOKEN` | |

Order is: environment variable, then credential store, then file. A token from the environment is only read. It is never written to the credential store or to disk. An empty variable counts as unset. With 1Password, put `op://` references in an env file and run Align through `op run`:

```bash
# align.env
ALIGN_GITHUB_TOKEN=op://Personal/Align GitHub/credential

op run --env-file=align.env -- align connect github --env local
```

`align local forget github` cannot unset a variable: while it is set, the source stays connected.

**Read-only scopes and expiry.** The token page Align opens is pre-filled only where the vendor documents a way to do that:

| Source | What is pre-filled | Expiry | Vendor documentation |
|---|---|---|---|
| GitHub | fine-grained token with `contents`, `issues`, `pull_requests` set to `read`, a name and description | 90 days (`expires_in=90`; GitHub's default is 30 days) | [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) |
| GitLab | name and the `read_api` scope, on gitlab.com or your own host | not available: GitLab documents only `name`, `description` and `scopes`. The form's own default applies | [Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/) |
| Slack | "create app from manifest" with four read-only user scopes (`channels:read`, `channels:history`, `groups:read`, `groups:history`) and no bot user | not available: Slack token rotation is a separate opt-in | [App manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) |
| Jira, Confluence | nothing: the page opens bare | the page offers an expiry (1 to 365 days) but takes no URL parameter. Pick a short one | [Manage API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) |
| Linear | nothing: the page opens bare | none documented | no URL parameters documented |
| Notion | nothing: the page opens bare. Tick only "Read content" | none documented | no URL parameters documented |
| Teams | nothing: Graph Explorer opens bare | about one hour | no URL parameters documented |

**Honest limits.** Teams has no personal token: you copy a Graph access token that lasts about an hour, so Teams syncs only when you run it (`align sync teams`). Zoom reads only your own cloud recordings, and a whole-account read needs an admin token, which Align does not ask for. A token is as read-only as the scopes you give it: check what the provider shows before you click create.

## How far back

Each connector reads the last **180 days** by default. `--since` changes that on `align connect <source>`
and on `align connect --source <id>`:

```bash
align connect github --since 30d     # 30 days
align connect jira --since 1y        # 365 days (2w = 14 days)
align connect slack --since all      # no start date; only the per-source ceiling applies
```

`Nd`, `Nw`, `Nm`, `Ny` and `all` are the only forms. A month is 30.4 days, rounded, so `--since 6m` is
182 days, not the default 180; the report names the exact length ("the last 180 days", "the last 6
months"). Anything else exits 2 and reads nothing, including `--days-back 30.5`. Slack's old
`--days-back <n>` means `--since <n>d`, and Slack's default window is now 180 days, not 90.

Every source also has a ceiling on how many items one run reads, and an 8 minute time budget:

| Source | Ceiling | | Source | Ceiling |
|--------|---------|-|--------|---------|
| GitHub | 3,000 | | Notion | 1,000 |
| Slack | 2,000 | | Microsoft Teams | 1,000 |
| Jira | 2,000 | | Zoom | 200 |
| Linear | 2,000 | | Git (with `--since`) | 5,000 |
| GitLab | 2,000 | | Repo docs | 500 |
| Confluence | 2,000 | | | |

Only GitHub, Slack and the git ceiling are measured; the others are provisional until a real
connect measures them. When a ceiling, the time budget or a vendor limit stops a read early, the
report says how far back it actually got and what stopped it, instead of printing a thin count that
looks like a quiet six months. "Imported" is what was stored: if a batch failed, the line says
"imported 20 of 40 (a batch failed)".

**Git is the exception.** By default it scans up to 20,000 commits, newest first, however old, and
keeps the newest 2,000 that have body text beyond trailers. `--since` makes it a window and lifts the
scan bound to the ceiling (5,000), and the keep cap of 2,000 still applies. An explicit `--limit` is
your own bound and has no keep cap.

GitHub reads items first, then fetches comments and reviews for as many as 600 requests allow,
newest first. The report says how many got their discussion ("discussion fetched for 188 of 312");
the rest stay without it until `align sync` reads them (a later run continues where the last one
stopped, 600 requests at a time). Inside a repo, on your local graph, it reads
everyone's pull requests and issues in that repo, as far as your token can see, and the report says
so; elsewhere, only yours.

From inside a coding agent, `align_backfill` does the same for a source you already connected. It
never takes a token: for a source that is not connected it hands back the `align connect` command
for you to run. At most one backfill per source and three at once run at a time.

## Whose items: yours, or your team's

Each source reads either **your own items** or **everyone's items in one place you name**, as far
as your token can see. There is no "everything": a team read always has a name.

| Source | What you can name | Without a name |
|--------|-------------------|----------------|
| GitHub | a repo (`--repo owner/repo`), or the repo you are in | your own items |
| GitLab | a project (`--gitlab-project group/project`), or the project you are in | your own merge requests |
| Jira | project keys (`--projects ALI,OPS`); with one project, a board (`--board`) or a JQL filter (`--jql`) | issues you are involved in |
| Linear | team keys (`--teams ENG`); with one team, projects (`--linear-projects`) | issues you are involved in |
| Confluence | space keys (`--spaces ENG,OPS`); inside them, page trees (`--confluence-pages`) | **nothing is read**: pick at least one space |
| Notion | pages or databases (`--notion-pages`), read with everything under them | every page shared with your integration |
| Slack, Teams | nothing to pick | everything your token can see (Slack: the channels it is in) |
| Zoom | nothing to pick | only your own cloud recordings; the whole account needs an admin token, which Align does not ask for |

```bash
align connect --source jira --projects ALI,OPS --yes   # no questions
align connect --source jira --scope yours --yes        # back to only your own
align connect                                          # at a terminal: pickers, with the keys your decisions cite preselected
```

Inside a repo, the choice is kept for that repo only, so two repos can read different Jira projects
or Notion pages. Inside a repo, each picker also offers "None, skip <source> in this repo", which is
kept per repo too.

The first time a source is read as a particular team scope (each repo, project set or space set counts separately, so widening later says it again), one line says what that means: "Importing items from
everyone in ... that your token can read. They stay on this machine." Nothing leaves your machine
unless you share a decision yourself. A repo your token cannot see (a private repo, a token with no
repo access) is not read as a team: it says so and reads only the items you are involved in. A choice you make is
checked against what your token can see before anything is fetched. A value that fails is refused
without being printed back, and the message counts the values that failed instead of naming them.

Widening is a new scope, so the next sync reads the whole window again for it (a few minutes, and
some of the source's rate limit). Going back to a scope you read before only catches up. Changing
scope never deletes an imported item; items from the wider scope stay and are no longer refreshed.

From inside a coding agent, `align_scope` shows each connected source's scope (`view`) and changes it
(`set`), through the same code the command uses, and records that an agent made the change. It never
takes a token: a source that is not connected gets the `align connect` command back for you to run.

**A wider scope that nobody at a terminal asked for waits for you.** That covers an agent's `align_scope set`,
a connect with no terminal or with `--json`, and a connect an agent started. Nothing reads it, in the
background or when an agent runs a sync, until you run `align sync <source>` at a terminal: that shows the
line above and asks "Read ... now?" (the default is No, and no terminal means no). Until then the source
keeps reading what it read before, and `align sync --status` says a change is waiting. Going back to only
your own items is immediate.

**What this does and does not stop.** It stops an agent that only has Align's tools, a script, and a background
job. It does not stop an agent that can run shell commands and drive a pseudo-terminal (`script`, `expect`):
that can answer the prompt itself, and Align cannot tell. Treat the prompt as a speed bump, not as proof of
consent. If you do not want an agent able to do this, do not give it a shell.

Without a terminal (or with `--json`), a connect never widens by itself: it does not turn the keys your
decisions cite into a project list, and it does not read a repo just because you are standing in one. At a
terminal the picker preselects the cited keys, and you choose.

Scope settings are saved in Align's config file next to your tokens. Two Align processes writing that file at
the same moment can lose one of the two writes (the file is read whole and written whole); a lost scope
change shows up as the old scope, and `align_scope view` or `align sync --status` shows what is in force.

The per-source commands (`align connect jira ...`) do not take scope flags; use `align connect --source
jira --projects ALI`. On the local graph `align connect confluence` reads the spaces already chosen, or
refuses and tells you how to choose them. If a vendor has more projects, spaces or teams than Align
lists (1,000, or 100 for Linear), a key that is not in the list is asked for directly before it is
refused.

## Keeping it up to date: `align sync`

```bash
align sync              # every connected source except Teams
align sync github jira  # just these
align sync --status     # what is connected, when it last synced, what is waiting
```

A sync reads only what changed since the last one (it starts a day before the last complete read,
so a late edit is not missed) and stores it the same way a connect does. It reads, it never writes
to a source, and it makes no AI calls. Specifically:

- **It never moves its bookmark past data it did not read.** A read a ceiling cut short in date order
  says so and the next sync finishes the older part before it moves on. A read with a hole in it (a
  channel that would not open, a repo the token cannot see) keeps the bookmark where the last complete
  read left it and reads again from there, so one stubborn skip never stops newer items arriving. The
  status separates "last complete sync" from "last tried" and says what was not read.
- **GitHub comments and reviews** arrive over several runs, newest first, 600 requests a run.
- **A refused token is recorded, never deleted.** Only a refusal of the token itself marks a source as
  needing you to reconnect (`align connect <source>`); a successful reconnect clears it. One repo or
  channel the token cannot see is a skip of that scope, shown in the status, and blocks nothing.
  Nothing here asks for a token.
- **Slack replies to older threads** are picked up for threads that had a reply in the last 30 days.
- **Teams is manual** (its token lasts about an hour): `align sync teams`, or `align connect teams`.
- One sync per source at a time, across terminals and agents. A second one says "already syncing".
- Stored items that never finished linking (all of them after an upgrade) are finished locally
  on the first sync, with no network and no AI calls.

### Refresh when you start Align

When you start `align` in a terminal, it refreshes each connected source in the background, at most
once every 15 minutes per source. It never waits for it, and it prints one line the first time.
The refresh runs from your home folder, so the folder you started in does not choose what it reads.
It makes no AI calls and sends no keys other than the saved connector tokens it reads from its own
config.

- `align sync --off` stops it, and `align sync --on` starts it again. This stops **only** the
  refresh at launch. `align sync`, `align_sync` and `align_backfill` still work, and a refresh that
  was already waiting to start (it waits 20 seconds) stops when it sees the switch.
- `ALIGN_NO_SYNC=1` stops it for one shell. CI and a session with no terminal never start it.
  `align sync --status` says when the refresh is off in this shell.
- It only refreshes a source that you have already synced or backfilled by hand once (`align sync github`).
  A source Align cannot read until you act (Confluence with no spaces chosen) is not retried every 15 minutes.
- `align sync --on` needs you at a terminal and is refused inside a coding agent; `--off` works anywhere.
  If Align cannot record that it already started a refresh (something in the way in its state folder),
  it skips that source, and `align sync --status` says why.
- A source whose saved login stopped working is named in one line at most once a day.
- Your own `DO_NOT_TRACK`, `CI` and `ALIGN_TELEMETRY` settings reach the refresh, and a stored opt-out
  (`align telemetry off`, or a `DO_NOT_TRACK` any earlier run saw) holds for it too. When telemetry is on,
  the refresh sends one `source_synced` ping per source with trigger `background` and no `cli.command`
  (see [telemetry](telemetry.md)).
- The first-use line and that reminder are remembered in your config file. Two Align processes that
  save the config at the same moment can lose one of those flags (the config is read, changed and
  written back without a lock). The result is one repeated line, not a wrong refresh.

Typing the relationships between imported items takes your own AI key, so it is always your call:

```bash
align sync --classify --max 25    # shows "up to 75 LLM calls on your <provider> key", then asks
```

From inside a coding agent, `align_sync` can show the status, start the same background refresh
and estimate the classification cost. It cannot classify, and it never takes a token.

`align local forget <source>` drops the token and the source's sync state and leaves what it
imported. Add `--purge` to delete the imported items too, for a connected source only (`github`,
`slack`, ...; never `git`, `cli` or a typo, which are refused). It shows the count and asks first
(`--yes` when there is no terminal). It deletes only items a connector import wrote and nobody has
handled: items you ratified, confirmed, captured by hand, acted on or judged are kept, as is
anything with no import identity. Deleted items are copied into the graph file first
(`decisions_purged_backup`), and the whole forget is one transaction, so a failure leaves the token
and every item as they were.

## Git

No auth needed. This is what `align` seeds from.

```bash
align connect git
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `20000` | Max commits to scan (`5000` once `--since` is given). Left at the default, a run keeps the newest 2,000 that have body text beyond trailers. An explicit `--limit` has no keep cap |
| `--since` | - | Read only this far back (`30d`, `6m`, ...). Without it, the newest commits however old |
| `--branch` | current branch | Git branch to scan |
| `--from` | - | Start date (ISO, e.g. `2025-01-01`) |
| `--to` | - | End date (ISO) |
| `--approve` | - | Skip confirmation prompt |

A plain commit is kept only if its message has body text beyond trailers and lines that repeat the
subject. It does not have to state a reason in so many words. A merge commit that was promoted
(its subject taken from the body) skips that check. The capture report counts the older commits
that qualified but were not imported, and `--limit` reads further back.

## Docs

No auth needed, same as Git. Reads ADR directories (`docs/adr`, `doc/adr`, `docs/decisions`,
`doc/decisions`, `adr/` - whichever convention your repo uses) and your own CLAUDE.md/AGENTS.md
content, split by section. It never re-imports what `align` already wrote into those files
(the managed nudge block and the `.align/decisions.md` import line) - that would be a feedback
loop, not a decision.

```bash
align connect docs
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `500` | Max items to import |
| `--approve` | - | Skip confirmation prompt |

## GitHub and GitLab

```bash
align connect github --token ghp_...
align connect gitlab --token glpat-...   # self-managed: create a read_api (read-only) token
```

GitHub scopes to the repo you are in by default (detected from the git remote) - a
personal token that can see many repos otherwise returns everything you are involved in
across all of them, undifferentiated. If no github.com remote is detected, the import is
unscoped unless you pass `--repo owner/repo`. Pass `--repo owner/repo` to name a different one, or
`--all` for every repo the token can see.

### PR descriptions on first run

A commit rarely says why. In squash-merge repos the reason is in the pull request description, so
the first run of `align --local` also reads the merged PR descriptions of a GitHub origin, with no
prompt and no account:

- It reads the newest 300 closed PRs by last update (3 pages; unmerged ones count against the 300) from the public GitHub API, unauthenticated, while
  git is being scanned. It never waits on GitHub for more than about 10 seconds.
- A PR becomes a decision only if its description states a reason (the same test the git import
  applies to commits), so template checklists and bot PRs are skipped. The decision's source is the
  PR url and its date is the merge date.
- The squash commit of an imported PR (the PR's merge commit) is not imported again: the change appears
  once, as the PR. `align connect git` afterwards skips those commits too. A PR merged by rebase leaves
  its other commits as commits.
- If GitHub's rate limit stops the read (HTTP 429, or 403 with no quota left), first run says "GitHub rate limit reached, imported commits
  only; run `align connect github` for PR descriptions" and carries on with commits.
- A `gh` token is used only when it is proven read-only (it can read, never write), and then the
  read covers up to 1,000 PRs with a higher rate limit. A token that can write is never used for the PR
  requests. (Proving it means one call to `api.github.com/user` with that token.)
- A repo whose origin is not on github.com (GitLab, another host, no remote) is not read this way.

`align connect github` writes the same row for the same PR, so running it afterwards adds
discussion and does not duplicate anything.

## Jira

```bash
align connect jira \
  --token <your-jira-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

## Linear

OAuth scope is `read`.

```bash
align connect linear --token lin_api_...
```

## Confluence

```bash
align connect confluence \
  --token <your-confluence-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

## Slack (experimental)

OAuth uses read scopes only, no `chat:write`. The Slack app needs public distribution enabled,
or you authorize from its home workspace.

Manually, `align connect slack` needs a Slack **user** token (`xoxp-...`), not a bot token. Go to
[api.slack.com/apps](https://api.slack.com/apps), create an app, and add these User Token Scopes
under OAuth & Permissions: `channels:read`, `channels:history`, `groups:read`, `groups:history`.
Install to your workspace and copy the OAuth User Token.

```bash
align connect slack --token xoxp-<your-slack-user-token>
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `2000` | Max threads to import (a ceiling, not a target) |
| `--since` | `180d` | How far back to read (see "How far back" above). `--days-back <n>` still works and means `--since <n>d` |

## Notion

Create an internal integration with **only "Read content"** capability, no insert or update,
then paste its secret:

```bash
align connect notion --token <your-notion-integration-token>
```

## Microsoft Teams

In local mode, paste a Microsoft Graph access token: sign in to
[Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer), open the
"Access token" tab and copy it. Reading channel messages needs `ChannelMessage.Read.All`,
which your Microsoft 365 admin may have to consent to. The token expires after about an
hour, so re-run `align --local` and pick Teams to paste a fresh one when you want to
refresh. `align connect teams --token <Graph token> --env local` imports once from the
command line without remembering the token; setup is what makes Teams show as connected.

## Zoom

Use `align` with a cloud account. Zoom has no personal token a human can create
in-app, so it isn't offered in local-only setup. `align connect zoom --token <OAuth token>`
exists for a token you got elsewhere.

## Connector scans (cloud)

With a cloud account, the gateway can run connector-side scans and hold the results as
suggestions for review.

```bash
align connect --all           # start a scan across every enabled connector
align connect list            # scan jobs and their status
align connect suggestions     # review what a scan found
align connect scan-runs       # scan history
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
