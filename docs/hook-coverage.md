# Where the edit check fires

The edit check is the hook that runs `align check --advisory` before an agent writes a file
(see [agent-hooks.md](agent-hooks.md) for what each host can do). Teams that run agents as
subagents, or in headless and SDK runs, need to know whether that hook still runs there.

This page answers it one cell at a time. Each cell says one of:

- **fires**: a payload the host really sent is saved in the repo, and a test replays it
  through align's own matcher and normaliser.
- **does not fire**: a capture shows the hook was not called. No cell is in this state yet.
- **not tested**: nobody has captured a payload for that cell. The host's documentation may
  say it works. That is a claim by the vendor, not evidence, so it does not make a cell "fires".

Read "not tested" as "unknown". It does not mean "fires", and it does not mean "does not fire".

## The table

Last checked 2026-11-18. Rows are hosts. The three columns are who made the edit and how the
agent was run.

| Host | Main agent, interactive session | Subagent | Headless or SDK run |
|---|---|---|---|
| **Claude Code** | not tested. No interactive capture was made. | fires, in a headless run: `by-cell/claude-code-headless-subagent-pre.json` | fires: `by-cell/claude-code-headless-main-pre.json` |
| **Codex** | not tested. `codex-pre.json` is a real payload, but it did not record whether the session was interactive. | not tested | not tested |
| **Cursor** | not tested. Cursor was not installed where this was written. | not tested | not tested |
| **Gemini CLI** | not tested. No model credentials were available to run a session. | not tested | not tested |
| **pi** | not tested. `pi-pre.json` is a real payload, but it did not record the run mode. | not tested. pi has no subagents in core. | fires: `by-cell/pi-headless-main-pre.json` |
| **OpenCode** | not tested. No interactive session was captured. | fires, in a headless run: `by-cell/opencode-headless-subagent-task-pre.json` and `by-cell/opencode-headless-subagent-edit-pre.json` | fires: `by-cell/opencode-headless-main-pre.json` |

Where a cell says "fires, in a headless run", it is the subagent and headless cells in one: the
capture was a headless run in which a subagent made the edit.

## Where it does not fire, or is not known to

Use the PR check. `align check` runs on the pull request against the diff, so an edit that no
hook saw still gets checked before it merges. Every "not tested" cell above falls back to it.
The PR check runs after the edit is written, so it flags a conflict later than the hook does.

## Evidence and documentation, per cell

The captures are in `src/__tests__/fixtures/hook-payloads/by-cell/`. Each file has a
`_capture` block with the host version, how it was captured and the date. Session ids,
transcript paths and working directories are redacted. Every other field is as the host sent it.
`src/__tests__/hook-coverage.test.ts` runs one block per "fires" cell, and a final block fails
the build if this page says "fires" without a capture, or leaves a capture file uncited.

| Host | Documentation read | What it says about these cells |
|---|---|---|
| Claude Code | [hooks reference](https://code.claude.com/docs/en/hooks) | Subagent tool calls fire the same `PreToolUse` hooks, and the payload carries `agent_id` and `agent_type`. It says hook events fire "wherever it runs" but does not state `-p` mode outright. The captures settle both. |
| Codex | [hooks](https://learn.chatgpt.com/docs/hooks) (moved from developers.openai.com/codex/hooks) | `PreToolUse` covers `apply_patch`. Hooks must be reviewed and trusted before they run. It lists `SubagentStart` and `SubagentStop` but does not say whether `PreToolUse` runs for a subagent's tool calls, and does not address `codex exec`. |
| Cursor | [hooks](https://cursor.com/docs/agent/hooks) | `preToolUse` fires for all tool types, including `Task`. There are `subagentStart` and `subagentStop` events. It does not say whether `preToolUse` fires for a subagent's own edits, or in `cursor-agent -p`. |
| Gemini CLI | [hooks](https://geminicli.com/docs/hooks/) and [reference](https://geminicli.com/docs/hooks/reference/) | Silent on subagents and on `-p` mode for `BeforeTool`. |
| pi | [README](https://github.com/earendil-works/pi) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | pi "skips features like sub-agents and plan mode". Extensions see `ctx.mode` as `tui`, `rpc`, `json` or `print`. The docs imply extensions run in print mode and do not say so outright. The capture settles it. |
| OpenCode | [plugins](https://opencode.ai/docs/plugins/), [build a plugin](https://opencode.ai/docs/build/plugins) and [server plugins](https://opencode.ai/docs/build/plugins/server) | Silent on child sessions and on `opencode run`. Only the capture shows the hook ran for the child session's edit. |

## How a cell was captured

- **Claude Code**: `claude -p` in a scratch repo, with a `PreToolUse` hook for `Write|Edit|MultiEdit`
  running `tee`. One run asked the main agent to edit a file. A second run asked it to start a
  subagent whose only job was the edit.
- **OpenCode**: `opencode run` with a project plugin that appended the arguments of its
  `tool.execute.before` hook to a file. The subagent run asked the model to call the `task` tool.
  The child session's edit reached the hook under a different `sessionID` from the parent's.
- **pi**: `pi -p -e <extension>` with a `tool_call` handler that appended the event and
  `ctx.mode` to a file. pi only loads a project extension after the project is trusted, so the
  extension was passed with `-e`. That is the same extension API align's own extension uses.

Both tests and captures cover the part align controls: whether the matcher accepts the tool and
whether the payload turns into proposed text. They do not run the model-backed check itself.

## Filling in a "not tested" cell

1. Read the host's current hook documentation first.
2. Capture one payload, following
   [the fixtures README](../src/__tests__/fixtures/hook-payloads/README.md), for exactly that
   cell: that actor, in that run mode.
3. Save it under `by-cell/` with a name of the form `<host>-<mode>-<actor>-pre.json`, and add a
   test block to `hook-coverage.test.ts`.
4. Change the cell here to "fires", citing the file. If the capture shows the hook was not
   called, write "does not fire" and say what you ran.
