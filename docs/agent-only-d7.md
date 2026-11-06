# Does agent-only use count toward D7? A recorded run (ALI-2076)

**Short answer.** Mostly yes, with one real gap that this change closes.

- **Counted before this change:** an agent that starts a new `align mcp` server each day. The server's start sends one `cli.command` with command `mcp`, so each such day shows up (run A).
- **Not counted before this change:** an agent that keeps one server running for days. It sent one ping on the day the server started and nothing after, so day 7 read as no use (run B, "before").
- **Not counted, by design:** an install where nobody ever saw the telemetry notice. The notice needs a terminal, and `align mcp` never shows it, so nothing sends (run C).
- **Added:** `cli.funnel.agent_active`. At most one a day per install, from the first successful MCP tool call that day, local mode only. Fields: install id, CLI version, command `mcp`, stage. No tool name, no count, no agent name (`src/__tests__/agent-only-d7-e2e.test.ts` run E checks the exact key set).

The ticket's guess that "hooks, doctor, local and background sync send none" is right, and
it does not matter for this question: the agent path was never a hook. What the ticket missed
is that the `mcp` command is an ordinary command, so its postAction ping already counted
sessions.

## What the run is

`src/__tests__/agent-only-d7-e2e.test.ts` runs the real CLI as real processes, no mocks:

- A fresh `HOME` stands in for a clean machine. The telemetry notice is pre-marked as shown,
  as a terminal run would have done (the notice needs a TTY, which a test process lacks).
- A preload shifts `Date` in every spawned process by whole days, so "day 7" is a real run of
  the real code that believes it is a week later. A second preload refuses any non-loopback
  connection.
- `ALIGN_GATEWAY_URL` points at a loopback server standing in for `POST /telemetry/anonymous`.
  Each captured body is mapped to the row the gateway writes into `anonymous_usage_events`:
  `cli.funnel.<stage>` when a stage is present, `cli.command` otherwise (same mapping as
  `telemetryAnonymousRoutes.ts` in align-stack). PostHog gets the same event name under
  `cli-local:<installId>`, plus `command`, `cliVersion`, `platform: cli`, `mode: local`.
- Day 0 is one terminal command (`align status`) standing in for install and setup. The setup
  wizard is interactive, and its own pings (`setup_completed`, `mcp_wired`) are day-0 one-offs
  that cannot carry day 7 either way. From day 1 the person types nothing: the agent starts
  `align mcp` and calls `align_get_conflicts` twice (a tool that needs neither the on-device
  embedding model nor a full git history, so the run works offline and in a shallow CI clone).
- Cloud mode is not simulated. Per the ticket, the gateway records `mcp.tool_invoked`
  server-side for every cloud tool call, so cloud agent use is already visible, and
  `agent_active` is local-only for that reason.

Regenerate the tables: `ALIGN_D7_RECORD_OUT=/tmp/d7.md npx vitest run src/__tests__/agent-only-d7-e2e.test.ts`.

## Before the change (the tool-call signal removed)

Taken from the same test with the one line that sends `agent_active` deleted (CLI at `origin/main` `ddd28fc` plus the new test).

#### A: the person types one command on day 0, then only their agent uses Align, a new MCP server each day

day | event_name | command | sent by
--- | --- | --- | ---
0 | cli.funnel.install | align | terminal: align status
0 | cli.command | status | terminal: align status
1 | cli.command | mcp | agent MCP, new server: align_get_conflicts
2 | cli.command | mcp | agent MCP, new server: align_get_conflicts
3 | cli.command | mcp | agent MCP, new server: align_get_conflicts
4 | cli.command | mcp | agent MCP, new server: align_get_conflicts
5 | cli.command | mcp | agent MCP, new server: align_get_conflicts
6 | cli.command | mcp | agent MCP, new server: align_get_conflicts
7 | cli.command | mcp | agent MCP, new server: align_get_conflicts

days with a cli.command ping (the D7 definition in the ticket): [0, 1, 2, 3, 4, 5, 6, 7]
days with a cli.command ping other than mcp (a person typed it): [0]
days with cli.funnel.agent_active (a tool call): []

#### B: the person types one command on day 0; the agent starts ONE server on day 1 and calls tools on days 1 to 7

day | event_name | command | sent by
--- | --- | --- | ---
0 | cli.funnel.install | align | terminal: align status
0 | cli.command | status | terminal: align status
1 | cli.command | mcp | agent MCP, one long-lived server

days with a cli.command ping: [0, 1]
days with cli.funnel.agent_active (a tool call): []

#### C: no terminal run ever showed the telemetry notice (it needs a TTY); only the agent uses Align

day | event_name | command | sent by
--- | --- | --- | ---

rows captured: 0

#### D: the same agent use with DO_NOT_TRACK=1

day | event_name | command | sent by
--- | --- | --- | ---

rows captured: 0


## After the change

#### A: the person types one command on day 0, then only their agent uses Align, a new MCP server each day

day | event_name | command | sent by
--- | --- | --- | ---
0 | cli.funnel.install | align | terminal: align status
0 | cli.command | status | terminal: align status
1 | cli.command | mcp | agent MCP, new server: align_get_conflicts
1 | cli.funnel.agent_active | mcp | agent MCP, new server: align_get_conflicts
2 | cli.command | mcp | agent MCP, new server: align_get_conflicts
2 | cli.funnel.agent_active | mcp | agent MCP, new server: align_get_conflicts
3 | cli.command | mcp | agent MCP, new server: align_get_conflicts
3 | cli.funnel.agent_active | mcp | agent MCP, new server: align_get_conflicts
4 | cli.command | mcp | agent MCP, new server: align_get_conflicts
4 | cli.funnel.agent_active | mcp | agent MCP, new server: align_get_conflicts
5 | cli.command | mcp | agent MCP, new server: align_get_conflicts
5 | cli.funnel.agent_active | mcp | agent MCP, new server: align_get_conflicts
6 | cli.command | mcp | agent MCP, new server: align_get_conflicts
6 | cli.funnel.agent_active | mcp | agent MCP, new server: align_get_conflicts
7 | cli.command | mcp | agent MCP, new server: align_get_conflicts
7 | cli.funnel.agent_active | mcp | agent MCP, new server: align_get_conflicts

days with a cli.command ping (the D7 definition in the ticket): [0, 1, 2, 3, 4, 5, 6, 7]
days with a cli.command ping other than mcp (a person typed it): [0]
days with cli.funnel.agent_active (a tool call): [1, 2, 3, 4, 5, 6, 7]

#### B: the person types one command on day 0; the agent starts ONE server on day 1 and calls tools on days 1 to 7

day | event_name | command | sent by
--- | --- | --- | ---
0 | cli.funnel.install | align | terminal: align status
0 | cli.command | status | terminal: align status
1 | cli.command | mcp | agent MCP, one long-lived server
1 | cli.funnel.agent_active | mcp | agent MCP, one long-lived server
2 | cli.funnel.agent_active | mcp | agent MCP, one long-lived server
3 | cli.funnel.agent_active | mcp | agent MCP, one long-lived server
4 | cli.funnel.agent_active | mcp | agent MCP, one long-lived server
5 | cli.funnel.agent_active | mcp | agent MCP, one long-lived server
6 | cli.funnel.agent_active | mcp | agent MCP, one long-lived server
7 | cli.funnel.agent_active | mcp | agent MCP, one long-lived server

days with a cli.command ping: [0, 1]
days with cli.funnel.agent_active (a tool call): [1, 2, 3, 4, 5, 6, 7]

#### C: no terminal run ever showed the telemetry notice (it needs a TTY); only the agent uses Align

day | event_name | command | sent by
--- | --- | --- | ---

rows captured: 0

#### D: the same agent use with DO_NOT_TRACK=1

day | event_name | command | sent by
--- | --- | --- | ---

rows captured: 0


## What counts as use (for the D7 definition)

A day counts as a day of use for an install when it has at least one of:

1. a `cli.command` whose command is not `mcp` (a person typed it), or
2. a `cli.funnel.agent_active` (an agent called an Align tool that day).

`cli.command` with command `mcp` is a session start, not use: it fires when an editor starts
the server, whether or not the agent ever calls a tool, so counting it inflates D7 for anyone
who merely has Align wired into an editor. It is also sent once per server start, so it
undercounts a server left running. Both are reasons to read `agent_active` rather than `mcp`
for agent use.

The install beacon (`install`) and `setup_completed` say an install happened. They are not use.

Silent by design, and so not counted: an install that never saw the notice, an install that
ran `align telemetry off` or set `DO_NOT_TRACK=1` / `ALIGN_TELEMETRY=0`, anything in CI, and
anything run from an agent hook.

D7 itself is derived server-side from install-id timestamps (the gateway's own comment on
the stage enum), so this document only names the events that feed it. The query is not in
this repo.
