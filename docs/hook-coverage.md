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
| **Claude Code** | not tested. No interactive capture was made. | fires, headless only: `by-cell/claude-code-headless-subagent-pre.json` | fires: `by-cell/claude-code-headless-main-pre.json` |
| **Codex** | not tested. `codex-pre.json` is a real payload, but it did not record whether the session was interactive. | not tested | not tested |
| **Cursor** | not tested. Cursor was not installed where this was written. | not tested | not tested |
| **Gemini CLI** | not tested. No model credentials were available to run a session. | not tested | not tested |
| **pi** | not tested. `pi-pre.json` is a real payload, but it did not record the run mode. | not tested. pi has no subagents in core. | fires: `by-cell/pi-headless-main-pre.json` |
| **OpenCode** | not tested. No interactive session was captured. | fires, headless only: `by-cell/opencode-headless-subagent-task-pre.json` and `by-cell/opencode-headless-subagent-edit-pre.json` | fires: `by-cell/opencode-headless-main-pre.json` |

"Headless only" means the subagent capture came from a headless run. A subagent edit in an interactive session is not tested.

## Where the hook may not run

Use the PR check. When a repository runs `align check` in CI against the pull request diff (see
[In CI](check.md#in-ci)), an edit that no hook saw still gets checked before it merges. Every
"not tested" cell falls back to it. If a repository has no such CI step there is no fallback,
and an edit the hook missed is not checked at all. The PR check runs after the edit is written,
so it flags a conflict later than the hook does.

## Evidence and documentation, per cell

The captures are in `src/__tests__/fixtures/hook-payloads/by-cell/`. Each file has a
`_capture` block with the host version, how it was captured and the date. Session ids,
transcript paths and working directories are redacted. Every other field is as the host sent it.
`src/__tests__/hook-coverage.test.ts` runs one block per "fires" cell, and a final block fails
the build if this page says "fires" without a capture, cites a capture under the wrong column, or leaves a capture file uncited.

| Host | Documentation read | What it says about these cells |
|---|---|---|
| Claude Code | [hooks reference](https://code.claude.com/docs/en/hooks) | Subagent tool calls fire the same `PreToolUse` hooks, and the payload carries `agent_id` and `agent_type`. It says hook events fire "wherever it runs" but does not state `-p` mode outright. The captures settle both. |
| Codex | [hooks](https://learn.chatgpt.com/docs/hooks) (moved from developers.openai.com/codex/hooks) | `PreToolUse` covers `apply_patch`. Hooks must be reviewed and trusted before they run. It lists `SubagentStart` and `SubagentStop` but does not say whether `PreToolUse` runs for a subagent's tool calls, and does not address `codex exec`. |
| Cursor | [hooks](https://cursor.com/docs/agent/hooks) | `preToolUse` fires for all tool types, including `Task`. There are `subagentStart` and `subagentStop` events. It does not say whether `preToolUse` fires for a subagent's own edits, or in `cursor-agent -p`. |
| Gemini CLI | [hooks](https://geminicli.com/docs/hooks/) and [reference](https://geminicli.com/docs/hooks/reference/) | Silent on subagents and on `-p` mode for `BeforeTool`. |
| pi | [README](https://github.com/earendil-works/pi) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | pi "skips features like sub-agents and plan mode". Extensions see `ctx.mode` as `tui`, `rpc`, `json` or `print`. The docs imply extensions run in print mode and do not say so outright. The capture records `ctx.mode` as `print`, noted beside the event by whoever captured it. |
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

The tests check only the part align controls: whether the matcher accepts the tool and whether
the payload turns into proposed text. They do not run the model-backed check.

## Filling in a "not tested" cell

1. Read the host's current hook documentation first.
2. Run exactly that cell: that actor, in that run mode. Record what the host sends with the
   recorder that fits its hook interface. A host with command hooks (Claude Code, Codex, Cursor,
   Gemini CLI) can point its hook at `tee`, as in
   [the fixtures README](../src/__tests__/fixtures/hook-payloads/README.md). pi and OpenCode have
   no command hook here, so use a recording extension or plugin, as in the list above.
3. If a payload arrives, save it under `by-cell/`. Name it `<host>-headless-main-pre.json` or
   `<host>-sdk-main-pre.json` for the headless column, and `<host>-<mode>-subagent-pre.json` for
   the subagent column. Add a `_capture` block with `host` set to the exact label in the first
   column of the table (for example `Claude Code`), plus the version, the mode and the date.
   Add a test block to `hook-coverage.test.ts` that replays the capture through the plugin or
   hook align writes, with the raw evidence checks (which actor sent it, which event) inside the
   function the guard runs. Then change the cell to "fires" and cite the file. For an interactive
   capture, also change the "keeps each capture under its own column" check, which today requires
   that column to hold none.
4. If the edit completed and no payload arrived, first prove the recorder was live: show that it
   loaded (pi, for instance, ignores a project extension until the project is trusted) and that
   its output file can be written. Also run a positive control with the same recorder configuration:
   the same event for the same tool, which must produce a record. A recorder matched only to `Edit`
   records nothing when the agent uses `Write`, and that is a recorder gap, not a host result. Keep
   the control's output with the evidence. If you cannot show all three, the run proves nothing, so
   leave the cell "not tested". If you can, change the cell to "does not fire". There is no payload to
   save, so do not add a file under `by-cell/`. Put the command you ran, the hook configuration
   and the evidence that the edit landed in the cell's notes on this page, and name the PR check
   as the fallback.
