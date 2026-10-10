# Telemetry: every event, every field

What the CLI sends, when, and how to stop it. This page is checked by a test
(`src/__tests__/telemetry-docs-parity.test.ts`) that sends each event through the real code
and compares the fields against the tables below, in both directions. A field that is sent
and not listed here fails the build, and so does a field listed here that is no longer sent.

The short version, for local-only mode:

- **It is on by default, and you are told first.** The first time you run `align` in a real
  terminal (stdin and stderr both a terminal), it prints this once, to stderr, before anything
  is sent:

  ```
  Align sends anonymous usage counts: which commands and coding agent you use,
  which tools you connect and how many items, the CLI version, and your OS.
  Never code, decision text, or file, repo or org names.
  Turn it off: align telemetry off (or DO_NOT_TRACK=1). Details: align.tech/privacy#cli
  ```

- **Nothing sends before that notice has printed in a real terminal.** A run with no terminal -
  output piped or sent to `/dev/null`, a hook, cron, systemd, `docker build`, an agent's shell
  tool - shows no notice and sends nothing, and it does not count as the first run: the notice
  waits for your next run in a terminal.
- **`align telemetry off` or `DO_NOT_TRACK=1` stops all of it.** An environment opt-out
  (`DO_NOT_TRACK` or `ALIGN_TELEMETRY=0`) is also remembered: the first align run that sees it
  stores "off" on this machine (with the variable's name and the date), so processes that never
  see the variable - an agent's `align mcp` server with a trimmed environment, the background
  sync - stay silent too. `align telemetry status` says so, and `align telemetry on` clears it.
  Bare CI is not remembered; it is checked on every run.
- **Nothing is sent from CI**, and the notice is not shown there. Nothing is ever sent by the
  commands align's installed hooks run (`align check --hook`, `align check --advisory`,
  `align context inject`). `align mcp`, and a run inside an agent `align` launched, show no
  notice, so they send nothing until it has printed in a terminal.

Nothing about your repo, your decisions, your files or you is ever sent.
`align telemetry status` prints the effective state and why.

## Turning it off

| Switch | What it stops | Where |
|---|---|---|
| `DO_NOT_TRACK=1` | Everything, both tiers, both modes. Remembered once any align run has seen it (see above). Set before the first run and the install count is never sent, even if you unset it later. The [consoledonottrack.com](https://consoledonottrack.com) convention. | environment |
| `ALIGN_TELEMETRY=0` | Same as above. Any value other than `1`, `true`, `yes` or `on` counts as off. | environment |
| `align telemetry off` | Everything, in both modes: local events and cloud-mode events. Stored on this machine. | command |
| Running in CI | Everything. Detected the way [ci-info](https://github.com/watson/ci-info) does (`CI`, `GITHUB_ACTIONS` and the other CI providers' variables). A CI run does not count as an install. | automatic |
| `align telemetry on` | Turns usage on (and undoes `align telemetry off`). | command |

Earlier versions asked a consent question at the end of setup. If you answered No there, that
answer stands, and it now means off, exactly like `align telemetry off`: nothing is sent, in
either mode, the two counts below and cloud-mode events included. `align telemetry on` turns it
back on.

## Sent always, unless turned off (the two counts)

Sent once the notice has printed in a terminal, or after `align telemetry on`. Never after
`align telemetry off` or a No to the old consent question. Both go to
`POST https://api.align.tech/telemetry/anonymous` with no account, no token and no tenant.
The gateway accepts nothing outside these fields (a strict schema) and mirrors the event to
PostHog under `cli-local:<installId>` with `platform: cli` and `mode: local`
added server-side.

### `cli.funnel.install`

Sent once per install, on the first run that shows the notice, before any prompt. Never again
for that install id once it has been sent. That first run waits for it, for at most 0.8
seconds. If the connection fails outright, the next run tries again; if the gateway does not
answer in time, it is not retried, so it is sent at most once. Other events do not hold up the
work you asked for: a command ping is sent after the command's own output, and waits at most 2
seconds (`align sync`'s own ping, 0.5). The `source_synced` pings from a sync you ran are sent
together and waited for at most 1.5 seconds in all, so a gateway that never answers costs a sync
about 2 seconds. No request follows a redirect: a gateway that answers with one is treated as a
failure and the body goes nowhere else. Not sent when the first run already holds a cloud login token (cloud
mode has its own, authenticated events) and not sent when the first command is
`align telemetry ...`.

| Field | What it is |
|---|---|
| `installId` | A random UUID generated once for this machine. Not derived from anything identifying. |
| `cliVersion` | The CLI's own version string, e.g. `0.38.0`. |
| `os` | Node's `process.platform`: `darwin`, `linux`, `win32` and the other values in that closed set. Not the OS version, not the architecture, not the hostname. |
| `stage` | Always `install`. |
| `command` | Always the literal `align`. The endpoint requires a command; this beacon must not say which command you ran first, so it sends the program's own name. |

### `cli.funnel.setup_completed`

Sent when the setup wizard finishes, after its closing message.

| Field | What it is |
|---|---|
| `installId` | The same random UUID as above. |
| `cliVersion` | The CLI version. |
| `stage` | Always `setup_completed`. |
| `command` | Always `setup`, the wizard that sent it. |

That is the whole beacon tier: `install` and `setup_completed`. They follow the same rule as
everything below; they are listed apart because they are the funnel's denominator.

## Sent after the notice, in local-only mode

On once the one-time notice has printed, or after `align telemetry on`. Off for an install that
answered No to the old consent question, and off after `align telemetry off`. Same endpoint as
above, same anonymity: no account, no token, no tenant.

### `cli.command` (local mode)

One per command you run.

| Field | What it is |
|---|---|
| `installId` | The same random UUID. |
| `cliVersion` | The CLI version. |
| `command` | The command's name, at most two words: `align` (opening your coding agent), `ask`, `use`, `sync`, `mark`, `connect git`, `decisions list`. Never its arguments, never the query you typed, never a path. `align mark` sends the word `mark` and nothing about what you marked: no kind, no id, no text. |

`align sync` sends this ping when you run it yourself. A background sync started by
`align_sync run`, and the background refresh that runs when you start `align`, each run
`align sync --background`, which sends no `cli.command` at all. The same goes for `align sync
--background` typed by a person: no `cli.command`, and its `source_synced` pings report trigger
`background`. `align_mark` over MCP is not a command you ran and sends nothing.

### `cli.funnel.<stage>` (local mode)

Milestone pings, one of `setup_started`, `import_completed`, `mcp_wired`,
`first_useful_decision` (once per install, the first non-empty answer, from `align ask` or
from an agent over MCP), `teammate_requested`, and the four session-import stages:
`sessions_scanned`, `candidates_found`, `candidates_confirmed` and `decisions_ratified`, and
`agent_launched` (bare `align` opened your coding agent).

`agent_launched` carries one extra field, the `agent` name (for example `claude-code`), and no
count. It is sent without waiting for it: starting your agent never depends on the network.

The session-import stages are the only ones that may carry a measurement, and it is exactly
two extra fields: a `count` and the `agent` name (one of the six coding agents the CLI can read
sessions for). Nothing about a session's content, a repo, a path or a file name is ever sent -
the counts are counts, and the agent is the name of a tool on your machine. `decisions_ratified`
is sent by `align ratify` with no count and no agent, because a ratification is a person
standing behind a claim rather than anything an agent did.

None of these, and no `cli.command`, is ever sent from inside an agent hook.

`source_synced` is the one stage with its own table below.

| Field | What it is |
|---|---|
| `installId` | The same random UUID. |
| `cliVersion` | The CLI version. |
| `stage` | Which milestone, from the list above. |
| `command` | The command that reached it, same rules as `cli.command`. |

### `cli.funnel.source_synced` (local mode)

`align sync` sends one per source each time it finishes reading that source, whether you ran it
or the background refresh did. It reports how many items were stored and how it went. It is sent
from the sync itself (including the detached background run, which is why it is the one event
that can come from a process you did not type a command into), under the same rules as every
other event here: nothing before the notice, nothing after `align telemetry off`, nothing under
`DO_NOT_TRACK=1` or `ALIGN_TELEMETRY=0`, nothing in CI and nothing from an agent hook. A source
that was not synced at all (already syncing, not connected, a backfill running, Teams, which is
refreshed by hand) sends nothing. Local-only mode sends it; cloud mode does not.

| Field | What it is |
|---|---|
| `installId` | The same random UUID. |
| `cliVersion` | The CLI version. |
| `stage` | Always `source_synced`. |
| `command` | Always `sync`. |
| `count` | How many items this run stored (new plus updated). A number, at most 100000. |
| `source` | Which kind of source, from a fixed list: `git`, `docs`, `github`, `jira`, `confluence`, `slack`, `teams`, `zoom`, `gitlab`, `linear`, `notion`. Never a repo, a site, a space, a channel or a project name. |
| `outcome` | How it went: `ok`, `partial` (stopped early, the next sync continues), `needs_reauth` (the source refused the saved token) or `error`. |
| `scope` | `yours` (your own items) or `team` (a repo you are inside, read for everyone). |
| `trigger` | What started it: `manual` (you ran `align sync`) or `background` (a background sync: your agent's `align_sync run`, or `align sync --background`, which is also how the refresh at launch runs). The gateway also accepts `connect`; the CLI does not send it yet. |

No title, URL, repo, organisation, author or id is ever in this body: it is built from these
five fields and nothing else.

## Cloud mode

Unchanged by the notice above. A cloud user is already on an authenticated connection to
Align's gateway, so usage events are on by default and `ALIGN_TELEMETRY=0` or
`DO_NOT_TRACK=1` turns them off, and so do `align telemetry off` and a No to the old consent
question. Nothing is sent from CI in cloud mode either. They go to
`POST <gateway>/telemetry/ingest` with your login token and tenant, and land in your tenant's
own `telemetry_events` table.

### `cli.command` (cloud mode)

| Field | What it is |
|---|---|
| `eventName` | Always `cli.command`. |
| `category` | Always `engagement`. |
| `platform` | Always `cli`. |
| `properties.command` | The command's name, at most two words. Never arguments or content. |

### `cli.funnel.<stage>` (cloud mode)

| Field | What it is |
|---|---|
| `eventName` | `cli.funnel.<stage>`, the same stage names as local mode. |
| `category` | Always `engagement`. |
| `platform` | Always `cli`. |
| `properties.command` | The command that reached the stage. |

## What is never sent

Your decisions, your code, your commit messages, file names or paths, the text of anything
you ask, your hostname, your IP as a stored field, your git remote, your email. The local-only
graph itself never leaves the SQLite file on your machine. The `/telemetry/anonymous` endpoint
rejects any field not in the tables above, so a future CLI cannot quietly send more without
the gateway also changing.
