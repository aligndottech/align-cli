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

"Can block" below means the narrow thing: opt-in via `--block-on-critical`, only
on a `critical` conflict, and only on a **retry** of a change a background adjudicator already
judged. One other deny exists, a ratified deterministic rule, and it is not opt-in. See
"Blocking is opt-in, everywhere" for both.

Two kinds of file appear in the second column. A **project** file lives in the repo you ran
`align` in, is committed, and covers the whole team. A **user** file lives under your
home directory, is written by `align` / `align mcp --setup` next to that host's MCP
entry, covers every project on this machine, and comes out again with `align mcp --remove`.
The vendor docs for each host are linked from the row.

Setup lists every file first, with user-wide files under their own heading, and asks before
writing. With no terminal it writes nothing unless you pass `--approve`. `align use --undo` takes
back what align wrote in the project and in the Codex and Cursor files. `align mcp --remove` takes
out the agent entries and the user hook files, and does not touch project files.

| Host | File `align` writes | Pre-edit check | Non-blocking context to the model | Can block | Payload fixture |
|---|---|---|---|---|---|
| **Claude Code** | project `.claude/settings.json` | yes (`PreToolUse`) | yes, on both Pre and Post | opt-in, critical retry only | real (Claude Code is the canonical shape) |
| **pi** | project `.pi/extensions/align.ts` | yes (`tool_call`) | yes, via the `tool_result` content patch | opt-in, critical retry only | real (captured 2026-11-12, align 0.75.1, pi 1.5.2) |
| **Gemini CLI** | project `.gemini/settings.json` | yes (`BeforeTool`) | yes, on `AfterTool` only | opt-in, critical retry only | from Gemini's docs |
| **OpenCode** | project `.opencode/plugins/align.js` | yes (`tool.execute.before`) | yes, by mutating the result in `tool.execute.after` | opt-in, critical retry only | from OpenCode's source |
| **Codex** | user `~/.codex/hooks.json` ([docs](https://developers.openai.com/codex/hooks)) | yes (`PreToolUse` on `apply_patch`) | yes, `PreToolUse` has `additionalContext` | opt-in, critical retry only | **pending real capture** |
| **Cursor** | user `~/.cursor/hooks.json` ([docs](https://cursor.com/docs/agent/hooks)) | yes (`preToolUse`, matcher `Write`) | yes, on `postToolUse` only (`additional_context`) | opt-in, critical retry only | **pending real capture** |
| **Copilot CLI** | user `~/.copilot/hooks/align.json` ([docs](https://docs.github.com/en/copilot/reference/hooks-reference)) | yes (`preToolUse` on `edit`/`create`/`str_replace_editor`/`apply_patch`) | yes, on `postToolUse` only (`additionalContext`) | opt-in, critical retry only | **pending real capture** |
| **Claude Desktop** | - (MCP only) | no hook API | no | no | - |
| **Windsurf** | - (MCP only) | no hook API | no | no | - |
| **Zed** | - (MCP only) | no hook API | no | no | - |
| **VS Code** | - (MCP only) | no hook API for the CLI to write | no | no | - |
| **JetBrains AI Assistant** | - (not detected; wire MCP by hand, see [mcp.md](mcp.md)) | not wired; no hook API documented for the IDE assistant | no | no | - |
| **Junie CLI** | - (not written) | not wired, and unlike the rows above this one is our gap: Junie CLI documents `PreToolUse` | no | no | - |

Every host still gets the MCP server and the `AGENTS.md` nudge, JetBrains once you have pasted
its config in yourself. Claude Desktop, Windsurf, Zed, VS Code and JetBrains AI Assistant do not
get the deterministic layer, and no amount of config on our side changes that.

**pi: the two things a real session settled.** Both are recorded in the row above now that a
payload has been captured, so they are here to stop the next reader re-deriving them.

- *The tools are declared only if the entry asks.* pi defaults every MCP server to `codemode`
  exposure, which makes the tools callable from a codemode script and hides them from the
  model's tool list. Setup therefore asks for `"exposure": "direct"` in both pi-owned entries,
  the user-level one and the project's `.pi/mcp.json`; without it the setup reports pi connected
  and the model has no align tool it can call by name.
- *The nudge names the tool in both forms.* pi registers every server tool as
  `mcp__<server>__<tool>`, so a pi session has `mcp__align__align_check_alignment` and not the
  bare name. The shared `AGENTS.md` block gives both, which is also what a host that prefixes
  tool names needs, and runs no host branch to get there.

**Junie CLI is the exception in that group, and the gap is ours rather than the host's.** It
documents seven hook events, `PreToolUse` among them, configured under a `hooks` key in
`~/.junie/config.json`. A `PreToolUse` hook there can return `"decision": "block"` or exit 2 to
deny a tool call, and can return `additionalContext` to put text in front of the model, which is
the same pair `--format claude` already renders. Nothing writes that file today. The feature is
in JetBrains' Early Access Program and applies to **Junie CLI only**, not to Junie inside the
IDE, so it is a follow-up rather than a missing line. Read 2026-09-21:
[Junie CLI hooks](https://junie.jetbrains.com/docs/junie-cli-hooks.html). Not verified against a
running Junie CLI.

### The three user-level hosts, and what is documented versus captured

The Codex, Cursor and Copilot CLI shims are written against each vendor's **published hook
schema**, cited in the table. The normaliser cases for them
(`src/lib/hook-payload.ts`) and the tests that pin them
(`src/__tests__/hook-payload-user-hosts.test.ts`) use that documented shape and say so in
their names. **No payload from a real session of any of the three has been captured yet.**
The machine this shipped from had none of the three CLIs installed; Codex was installed via
`npx` and ran `apply_patch` end to end, but never fired a `hooks.json` on any of five
attempts (project-level, user-level, `[features].hooks`, `--enable hooks`), so there was no
session to capture from.

That matters because the bit the docs leave out is exactly the bit that goes wrong: the
field names inside `tool_input` / `toolArgs` for each host's edit tool. Until a capture
lands in `src/__tests__/fixtures/hook-payloads/` (its README says how), the honest status
is: **the hook files are written and the output shapes are right; whether the pre-edit
check can read the proposed text depends on the field names being what the docs imply.**
If they are not, the pre-edit check exits 0 in silence (fail-open) and the post-edit check,
which reads the landed `git diff` rather than the payload, still carries the finding on
Cursor and Copilot.

Two things the docs did settle, both of which used to be stated wrongly on this page:

- **Cursor** has a generic `preToolUse` (matcher `Write` for file edits) that can deny with
  an `agent_message`, and a `postToolUse` with an `additional_context` channel. The earlier
  claim that its only file hooks were `beforeReadFile`/`afterFileEdit` is out of date.
- **Codex** `PreToolUse` intercepts `apply_patch` (the docs accept `Edit|Write` as matcher
  aliases for it), not Bash alone, and it has an `additionalContext` output channel. Hooks
  are on by default; `[features].codex_hooks` is the deprecated spelling of
  `[features].hooks`.

One more difference worth knowing on **Copilot CLI**: a non-timeout, non-zero exit from a
`preToolUse` hook **denies** the tool call there. `align check --advisory` exits 0 on every
path for that reason, and the shim's `timeoutSec` is 10.

If you set up before 0.58.0, rerun `align mcp --setup`: the older hook file can deny edits when `align` is missing.

### A user-level hook does not run in the project

Cursor documents that user-level hook scripts run from `~/.cursor/`. The post-edit check
reads `git diff` in the current directory, and the surfaced-decision and verdict stores are
keyed on it too, so a hook started somewhere else would look at the wrong tree, or exit 0 in
silence because `~/.cursor` is not a repository. Every host puts the workspace in the
payload's `cwd`; `align check --advisory` moves there first when it exists.

The exception is Cursor's `sessionStart` payload, which has no `cwd` and names the workspace in
`workspace_roots`. `align context inject --format cursor` reads the first root only, so in a
multi-root workspace it finds decisions only if the first root has them.

For `align context inject`, a payload that names a path that is not a directory (a stale or deleted
workspace) prints nothing, on every host except Claude Code. Codex, Gemini and Copilot use the process
directory only when the payload supplies neither a `cwd` nor a first `workspace_roots` entry.

## The read path: putting the decisions back in front of the agent

Everything above is the write path: a hook fires when the agent proposes an edit. This part
is the read path. Nothing in MCP pushes content at the model, so without a hook the graph only
reaches it if it chooses to open `.align/decisions.md` or call a tool. A **session-start hook**
fixes that at the start of a session. A compaction can drop those decisions from the summary,
so the second question is whether the agent can put them back **after a compaction**.

`align context inject` is the command every host runs. It prints the file `align context sync`
last wrote (`.align/decisions.md`) in the shape that host reads, and prints nothing if there is
no file. It makes no network call, so it fits inside a hook. `align setup` writes the hook.

### What each agent allows (read 2026-11-18)

Every cell below comes from the agent's own documentation on that date, not from the
September list. "Wired" means `align setup` writes it and a test pins it. No hook payload in
this table was captured from a live session; the fixtures in
`src/__tests__/fixtures/session-start-payloads/` are the documented shapes (see its README).

| Agent | Session-start hook that can inject | Hook after a compaction | What Align does | Docs read |
|---|---|---|---|---|
| **Claude Code** | yes, `SessionStart`, sources `startup`, `resume`, `clear`, `compact`, `fork`; `additionalContext` | `PostCompact` exists but has no decision control and cannot inject. The `compact` source of `SessionStart` is what re-injects | **Wired**: `.claude/settings.json`, matcher `startup\|resume\|clear\|compact\|fork` | [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) |
| **Codex** | yes, `SessionStart`, sources `startup`, `resume`, `clear`, `compact`, `fork`; `hookSpecificOutput.additionalContext` | `PreCompact` and `PostCompact` exist, plain-text output is ignored, no context channel. The docs say to use `SessionStart` with the `compact` matcher | **Wired**: `~/.codex/hooks.json`, matcher `startup\|resume\|clear\|compact\|fork`. The Codex plugin's hooks file carries the edit check only, not this hook: a plugin hook runs through `npx`, which can miss the ten-second window, and with both installed the decisions would arrive twice. Codex skips a new hook until you approve it once, interactively | [learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks) (redirect from developers.openai.com/codex/hooks) |
| **Gemini CLI** | yes, `SessionStart`, sources `startup`, `resume`, `clear`; `hookSpecificOutput.additionalContext`, injected as the first history turn in an interactive session and prepended to the prompt in a non-interactive one | none that injects. `PreCompress` is advisory and can only show a message. No post-compression event | **Wired for session start**: `.gemini/settings.json`, one exact matcher per source. After a compaction: the fallback below | [geminicli.com/docs/hooks/reference](https://geminicli.com/docs/hooks/reference/) |
| **Copilot CLI** | yes, `sessionStart`, sources `startup`, `resume`, `new`, no matcher; a top-level `additionalContext` is consumed | none that injects. `preCompact` is notification only | **Wired for session start**: `~/.copilot/hooks/align.json`. After a compaction: the fallback below | [docs.github.com/en/copilot/reference/hooks-reference](https://docs.github.com/en/copilot/reference/hooks-reference) |
| **Cursor** | documented: `sessionStart` with a top-level `additional_context`, fire-and-forget, added to the conversation's initial system context. Forum reports say it never arrives, see below | `preCompact` exists and is observational: it cannot block, modify or inject | **Wired per docs; injection reliability unverified.** `~/.cursor/hooks.json`, no matcher. After a compaction: the fallback below | [cursor.com/docs/hooks](https://cursor.com/docs/hooks), read 2026-11-18 |
| **pi** | none that injects. `session_start` (reasons `startup`, `reload`, `new`, `resume`, `fork`) documents no return value. `before_agent_start` can return a `message` the model sees, but it fires on every prompt | `session_compact` is for observation. `session_before_compact` can supply the summary, which is not a way to add decisions | **Not wired.** Fallback below | [pi extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), first 100,000 of 158,000 characters read |
| **OpenCode** | none documented. The current plugin docs have a `session` `context` hook that can add to the system prompt on every model call, which is per call, not session start | none documented. The `compaction` hook runs before the summary, not after | **Not wired.** Fallback below | [opencode.ai/docs/build/plugins/server](https://opencode.ai/docs/build/plugins/server) |

Claude Code and Codex cover the compaction through `SessionStart` with a `compact` source. That
is the only mechanism any agent documents today for putting content back after one. Gemini CLI
and Copilot CLI get the decisions at the start of a session and have nothing for the moment
after a compaction.

**What an agent without a hook for a given moment gets.** The edit check, the MCP tools and the
PR check do not depend on the session hook, so a long session still has them:

1. **The per-edit check** (the write path above). Every agent in the table has a pre- or
   post-edit hook, so `align check --advisory` surfaces related decisions on each edit,
   whatever the context window has lost. This is the main fallback.
2. **The MCP tools** (`align_check_alignment`, `align_ask`). The agent can ask when it
   remembers to. Nothing prompts it to.
3. **The PR check** (`align check --ci`, see [check.md](check.md)). It reads the diff in CI, so
   a decision lost mid-session is still caught before merge.

An OpenCode user who wants the decisions in context without a hook can list `.align/decisions.md`
under `instructions` in `opencode.json`; OpenCode's config docs say it loads those files alongside
`AGENTS.md` ([opencode.ai/docs/config](https://opencode.ai/docs/config/), read 2026-11-18).
`align context sync` writes that file. For pi, no documented way to do the same was found.

`align context inject` only reads a decisions file that sits in the workspace, or in Align's own
config directory where a local graph keeps it. A `.align/decisions.md` that links to a file
elsewhere is ignored, so a workspace you did not write cannot make a user-level hook send an
arbitrary file to the model. From a subdirectory it uses the nearest file, up to the git root.

### Why Cursor is wired with a caveat, and why Copilot CLI is now

**Cursor: wired per its documentation, and not known to work.** Cursor's docs (read 2026-11-18)
describe `sessionStart` with an output field `additional_context` ("Added to the conversation's
initial system context"), and say the hook is fire-and-forget. The docs show no complete example
output. Cursor's own forum has open reports that the hook runs, its log says the text was
accepted, and the text never reaches the model: for the IDE
([forum.cursor.com/t/158452](https://forum.cursor.com/t/sessionstart-hook-additional-context-is-never-injected-into-agents-initial-system-context/158452)),
and reports on the Agents Window (3.24.9, 17 Oct 2026) and the Cursor SDK (7 Oct 2026). Search
results on 2026-11-18 found no changelog entry saying it is fixed. Some third-party notes say
the Cursor CLI does deliver it. **These are unverified third-party reports** from search results
and the forum. None was reproduced here, and Cursor is not installed on the machine this was
written on, so the fixture is the documented shape, not a capture. The hook is wired because
the current documentation says it works, and a hook that runs and is swallowed reads as
delivered, so do not read "wired" as "delivered". Cursor documents that `sessionStart` does not
run in cloud agents.

**To verify on a real Cursor.** Do these in order and stop at the first one that fails, because a
failed setup step says nothing about Cursor.
1. Run `align context sync` in a project, then `align setup`.
2. Check that `.align/decisions.md` exists and that `~/.cursor/hooks.json` has a `sessionStart`
   entry running `align context inject --format cursor`.
3. Check the command prints the text. This probe does not involve Cursor, so it proves only
   that the command works:
   `node -e 'console.log(JSON.stringify({workspace_roots:[process.cwd()]}))' | align context inject --format cursor`
   must print one JSON line with `additional_context`.
4. Add a fresh marker that only the hook output carries. Append a line such as
   `marker-4f9c2e71` (make up your own random string) to `.align/decisions.md`, and do not write
   it anywhere else in the project, in a rule file or in the chat. Do not tell the model the value.
5. Open a new Agent chat in that project and ask: "What marker string is in your initial
   context? Do not open any file or call a tool." An exact match means the text reached the model.
6. If the model cannot give it, find Cursor's own record that the hook ran for that same chat
   (the Hooks output channel or its hook log) and what it printed. Count a failure as a delivery
   failure only if that record shows the hook ran and printed the marker. If you cannot find that
   record, write the result down as inconclusive. Update this row with the Cursor version and the
   result, and remove the marker line.

Until then, Cursor's delivery is unconfirmed. Do not treat it as equivalent to Claude Code's.

**Copilot CLI.** The September list said its `sessionStart` output is ignored. The current
reference says "Only `additionalContext` is consumed for `sessionStart`", so that row was
reversed and the hook is wired. Two upstream issues (github/copilot-cli#1730, #2201) reported it
not firing reliably. They were not re-checked on 2026-11-18, so treat delivery as unconfirmed
until a real session is captured.

**Gemini CLI.** The September note said the reference and the tutorial disagreed on the output
field. Read again, they do not contradict each other: the reference documents `additionalContext`
(injected) and `systemMessage` (shown to the user), and the tutorial's example only prints a
`systemMessage`. The hook is wired on the reference page's word. It has not been run against a
live Gemini CLI, which was installed without auth on the machine this was written on.

### What shipped

`writeClaudeCodeSessionHook` (`src/lib/agent-rules.ts`) writes the Claude Code hook into the
project's `.claude/settings.json`. `writeGeminiHooks` (same file) adds the three Gemini
`SessionStart` groups to `.gemini/settings.json`. `writeUserHooks` (`src/lib/user-hooks.ts`) is
the one writer for the Codex, Cursor and Copilot CLI files and adds their session entry beside the edit
check, so `align mcp --remove` takes both out together. A Codex, Cursor or Copilot session entry you edited is kept, and
setup says so, the same rule as the edit-check entries. The Gemini groups are rewritten on every
setup run, and `align use --undo` is what takes them out.

**Freshness, stated plainly.** The hook delivers whatever `align context sync` last wrote. A user
who never ran it gets nothing (the hook prints nothing), and one who ran it last week gets last
week's file. Fetching inside the hook was rejected: `sync` needs the network and auth, and a hook
has ten seconds.

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
- **What each decision says** - the hook shows up to 200 characters of each surfaced decision
  under its title (800 in total), with secrets redacted.
- **Dependencies** - an edit that adds an npm dependency (a new key in `package.json`, or an import of a
  package the nearest `package.json` does not list) is also checked as the sentence "Add dependency X to
  package.json", so a rule about new dependencies surfaces. Other manifests are not covered yet.

Adding a host is a payload case, an output case, and a writer. It is not a change to the
check.

### The recurring shape: pre-check, post-delivery

Claude Code, pi, Gemini CLI, Cursor and Copilot CLI all converge on the same split, for
different reasons:

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
- **Cursor** and **Copilot CLI** - `preToolUse` reads a permission decision and nothing
  else, so a non-blocking pre-check emits nothing and `postToolUse` carries the context
  (`additional_context` / `additionalContext`). Both events are registered for that reason.
- **Claude Code** and **Codex** - the ones where `PreToolUse` can do both, via
  `additionalContext`. Codex speaks Claude Code's hook shape, so `--format codex` renders
  the same JSON.

In every case the check still inspects the **proposed** change before it is written. Only
the delivery point moves.

### Verify the caller, not the type signature

OpenCode's hooks are both declared `=> Promise<void>`, so the types alone do not say
whether mutating the `output` argument changes anything. That question is settled in
`packages/opencode/src/session/tools.ts`, where the trigger is followed immediately by
`return output` on the same object - mutation propagates. Both halves of this shim were
confirmed that way rather than from the plugin docs, which state the `after` signature
without saying what the caller does with it.

## Blocking is opt-in, everywhere

Default behaviour on every host is: surface the finding, never deny the edit on a model's
judgement. Two things can deny. `--block-on-critical` denies a retry, only on a `critical`
conflict, and never after the edit has already landed. A ratified deterministic rule (an email
address, a card number, a known credential format, once your team has accepted the matching
starter rule) denies the first attempt with no flag, because a person ratified it and a computed
match proves it. See [check.md](check.md).

How a deny can happen at all: the hook asks for a verdict itself, but a model-backed one usually
does not fit its window. With the flag set, a hook whose retrieval found related decisions, and
whose verdict did not arrive in time, also spawns a detached
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

Which hosts fire the check for a subagent's edit, or in a headless run, is in
[hook-coverage.md](hook-coverage.md), with the cells nobody has tested shown as such.

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
