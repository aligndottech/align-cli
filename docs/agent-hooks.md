# The deterministic guardrail, per agent

Align makes itself available to coding agents two ways:

1. **Model discretion** - the MCP server's instructions plus the `AGENTS.md` / `CLAUDE.md`
   nudge. Works in every MCP-capable agent. The model decides whether to look.
2. **Deterministic** - a host hook that runs `align check --advisory` on every file edit,
   so the conflict reaches the model whether or not it thought to ask.

The second one is the valuable one, and it is **not uniformly available**, because it
needs the host agent to expose a hook API. There is no cross-agent standard. This page
records exactly what each host can do, so nobody has to infer it from whether a config
file got written.

## What each host can actually do

"Can block" below always means the same narrow thing: opt-in via `--block-on-critical`, only
on a `critical` conflict, and only on a **retry** of a change a background adjudicator already
judged. See "Blocking is opt-in, everywhere" for why.

| Host | Config `align setup` writes | Pre-edit check | Non-blocking context to the model | Can block |
|---|---|---|---|---|
| **Claude Code** | `.claude/settings.json` | yes (`PreToolUse`) | yes, on both Pre and Post | opt-in, critical retry only |
| **pi** | `.pi/extensions/align.ts` | yes (`tool_call`) | yes, via the `tool_result` content patch | opt-in, critical retry only |
| **Gemini CLI** | `.gemini/settings.json` | yes (`BeforeTool`) | yes, on `AfterTool` only | opt-in, critical retry only |
| **OpenCode** | `.opencode/plugins/align.js` | yes (`tool.execute.before`) | yes, by mutating the result in `tool.execute.after` | opt-in, critical retry only |
| **Cursor** | - | **no** | **no** | no |
| **Codex CLI** | - | **no** (Bash only) | no | Bash only |
| **Windsurf, Zed, VS Code** | - | no hook API | no | no |

Everything in the last four rows still gets the MCP server and the `AGENTS.md` nudge.
They just do not get the deterministic layer, and no amount of config on our side changes
that.

### Why Cursor cannot do it

Cursor 1.7+ has a real hook system (`.cursor/hooks.json`), and it is not enough here:

- There is **no `beforeFileEdit`**. The file-related hooks are `beforeReadFile` and
  `afterFileEdit`.
- `afterFileEdit` has **no output fields at all** - it is observational, for auditing and
  formatters. It cannot return anything the agent will read.

So on Cursor we could detect a conflict and have nowhere to put it. `beforeShellExecution`
and `beforeMCPExecution` *can* deny with an `agent_message`, but neither fires on a file
edit. We write `.cursor/rules/align.md` instead, which is the discretionary layer.

### Why Codex CLI cannot do it

Codex's hook engine is opt-in (`[features].codex_hooks = true`) and, by design,
**`PreToolUse` intercepts the Bash tool only**. `apply_patch`, Edit, Write, Read, web fetch
and MCP calls do not fire it.

## The architecture: one engine, N shims

Every shim runs the same command. Nothing host-specific lives in the check itself.

```
host hook  ->  align check --advisory --format <host>  ->  host-shaped JSON on stdout
```

- **In** - `normalizeHookPayload` (`src/lib/hook-payload.ts`) accepts whichever payload
  shape the host sent and maps it to one canonical `HookPayload`. The engine never learns
  which agent it is serving.
- **Out** - `buildRelatedOutput` / `buildUnknownOutput` (`src/commands/check.ts`) build the
  finding - related, unadjudicated decisions, or an explicit "could not check" notice - and
  `renderForHost` wraps it in the shape that host reads. `--format text` is the fallback for
  anything not listed above: plain prose, for a host that just runs a command and shows what
  it printed.

Adding a host is a payload case, an output case, and a writer. It is not a change to the
check.

### The recurring shape: pre-check, post-delivery

Claude Code, pi and Gemini CLI all converge on the same split, for different reasons:

- **pi** - `tool_call` fires before the edit but can *only* return `{block, reason}`. So the
  check runs there and its finding is replayed into that same call's `tool_result`, whose
  `content` patch is non-blocking.
- **Gemini CLI** - `BeforeTool` reads `decision`/`reason` and has no `additionalContext`
  channel, so a non-blocking pre-check emits **nothing** there and `AfterTool` carries the
  context.
- **OpenCode** - `tool.execute.before` runs ahead of `item.execute(...)`, so the only way
  to stop an edit is to **throw**; there is no `{block}` return value. The non-blocking
  finding rides `tool.execute.after`, which is handed the result object the caller
  returns on the very next line, so mutating `output.output` reaches the model.
- **Claude Code** - the only one where `PreToolUse` can do both, via `additionalContext`.

In all four the check still inspects the **proposed** change before it is written. Only
the delivery point moves.

### Verify the caller, not the type signature

OpenCode's hooks are both declared `=> Promise<void>`, so the types alone do not say
whether mutating the `output` argument changes anything. That question is settled in
`packages/opencode/src/session/tools.ts`, where the trigger is followed immediately by
`return output` on the same object - mutation propagates. Both halves of this shim were
confirmed that way rather than from the plugin docs, which state the `after` signature
without saying what the caller does with it.

## Blocking is opt-in, everywhere

Default behaviour on every host is: surface the finding, never deny the edit. `--block-on-critical`
is the only path that denies, and only on a `critical` conflict, and never after the edit has
already landed.

How a deny can happen at all, given the hook is retrieval-only inside its window (ALI-570):
with the flag set, a hook whose retrieval found related decisions also spawns a detached
adjudicator for that exact proposed change. The adjudicator runs the full check after the
hook window closes and records a verdict, with a 15-minute expiry. A later PreToolUse
proposing the same change is answered from that verdict - denied if it holds a critical
conflict, surfaced as context on the hosts that have a channel for it.

**A deny lands on a retry, never on a first proposal.** The verdict is keyed on the tool, the
target file and the text together, so it can only answer a re-presentation of the change that
was actually adjudicated. An agent that adjusts its approach, or edits a different file, keys
differently and goes through untouched. That narrowness is the design: this is a second-chance
guardrail, not an interceptor.

On **Gemini CLI** the non-blocking half of that has nowhere to go, because `BeforeTool` reads
`decision`/`reason` and has no `additionalContext` channel (the table above says so). A
critical verdict still denies there; a warning-only verdict falls through to the normal
retrieval path so `AfterTool` can carry it.

Two costs worth stating before you opt in:

- **In local mode the adjudicator calls your own AI provider** (the same terms as
  `align check`), which the default hook never does.
- **It runs per edit, not per session.** The content dedup only catches a re-proposal of the
  identical change, and an agent iterating produces different content every time - so expect
  roughly one background adjudication per edit where retrieval found anything, capped at 3 in
  flight per project at once. Over the cap the hook skips the spawn and loses the verdict,
  never the edit.

**It is not a boundary against the agent itself.** An agent with shell access can delete or
pre-seed the verdict store. It constrains an agent that is not trying to get around it, which
is the honest claim and still the useful one.

This is deliberate. A guardrail that blocks on a false positive gets switched off, and then it
protects nothing. Fail-open also covers align being missing, slow, unauthenticated or
unreachable - all of those let the edit through untouched.

## Verifying a shim actually fires

Config presence is not enforcement. To check a host really runs it:

```bash
# 1. does the engine work at all, independent of any host?
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"x.ts","content":"<a change you know conflicts>"}}' \
  | align check --advisory --format text

# 2. does the HOST invoke it? make the failure loud and unmissable
#    (temporarily point the shim's command at `sh -c 'echo FIRED >&2; exit 0'`)
```

Step 2 is the one people skip. A shim that is registered but never invoked looks exactly
like a shim that ran and found nothing - both are silent.
