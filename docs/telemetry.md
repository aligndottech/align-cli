# Telemetry: every event, every field

What the CLI sends, when, and how to stop it. This page is checked by a test
(`src/__tests__/telemetry-docs-parity.test.ts`) that sends each event through the real code
and compares the fields against the tables below, in both directions. A field that is sent
and not listed here fails the build, and so does a field listed here that is no longer sent.

The short version, for local-only mode:

- **It is on by default, and you are told first.** The first time you run `align`, it prints
  this once, to stderr, before anything is sent:

  ```
  Align sends anonymous usage counts: which commands and coding agent you use,
  which tools you connect and how many items, the CLI version, and your OS.
  Never code, decision text, or file, repo or org names.
  Turn it off: align telemetry off (or DO_NOT_TRACK=1). Details: align.tech/privacy#cli
  ```

- **Nothing sends before that notice has printed.**
- **`align telemetry off` or `DO_NOT_TRACK=1` stops all of it.**
- **Nothing is sent from CI**, and the notice is not shown there. Nor from inside an agent hook,
  from `align mcp` before the notice has printed in a real terminal, or from a run inside an
  agent `align` launched before the notice has printed.

Nothing about your repo, your decisions, your files or you is ever sent.
`align telemetry status` prints the effective state and why.

## Turning it off

| Switch | What it stops | Where |
|---|---|---|
| `DO_NOT_TRACK=1` | Everything, both tiers, both modes. Set before the first run and the install count is never sent, even if you unset it later. The [consoledonottrack.com](https://consoledonottrack.com) convention. | environment |
| `ALIGN_TELEMETRY=0` | Same as above. Any value other than `1`, `true`, `yes` or `on` counts as off. | environment |
| `align telemetry off` | Everything, in local-only mode. Stored on this machine. | command |
| Running in CI | Everything. Detected the way [ci-info](https://github.com/watson/ci-info) does (`CI`, `GITHUB_ACTIONS` and the other CI providers' variables). A CI run does not count as an install. | automatic |
| `align telemetry on` | Turns usage on (and undoes `align telemetry off`). | command |

Earlier versions asked a consent question at the end of setup. If you answered No there, that
answer stands: usage stays off and the two counts below still send, as they did before.
`align telemetry off` stops those too.

## Sent always, unless turned off (the two counts)

Sent once the notice has printed (or, on an install from before the notice, whatever you
answered at the old consent question). Both go to
`POST https://api.align.tech/telemetry/anonymous` with no account, no token and no tenant.
The gateway accepts nothing outside these fields (a strict schema) and mirrors the event to
PostHog under `cli-local:<installId>` with `platform: cli` and `mode: local`
added server-side.

### `cli.funnel.install`

Sent once per install, on the very first run of any command, before any prompt. Never again
for that install id. Not sent when the first run already holds a cloud login token (cloud
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

That is the whole beacon tier: `install` and `setup_completed`. They are the only events an
install that answered No to the old consent question still sends.

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
| `command` | The command's name, at most two words: `align` (opening your coding agent), `ask`, `use`, `import git`, `decisions list`. Never its arguments, never the query you typed, never a path. |

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

| Field | What it is |
|---|---|
| `installId` | The same random UUID. |
| `cliVersion` | The CLI version. |
| `stage` | Which milestone, from the list above. |
| `command` | The command that reached it, same rules as `cli.command`. |

## Cloud mode

Unchanged by the notice above. A cloud user is already on an authenticated connection to
Align's gateway, so usage events are on by default and `ALIGN_TELEMETRY=0` or
`DO_NOT_TRACK=1` turns them off. Nothing is sent from CI in cloud mode either. They go to `POST <gateway>/telemetry/ingest` with your login
token and tenant, and land in your tenant's own `telemetry_events` table.

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
