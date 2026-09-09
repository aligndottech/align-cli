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

Two kinds of file appear in the second column. A **project** file lives in the repo you ran
`align setup` in, is committed, and covers the whole team. A **user** file lives under your
home directory, is written by `align setup` / `align mcp --setup` next to that host's MCP
entry, covers every project on this machine, and comes out again with `align mcp --remove`
(ALI-952). The vendor docs for each host are linked from the row.

| Host | File `align setup` writes | Pre-edit check | Non-blocking context to the model | Can block | Payload fixture |
|---|---|---|---|---|---|
| **Claude Code** | project `.claude/settings.json` | yes (`PreToolUse`) | yes, on both Pre and Post | opt-in, critical retry only | real (Claude Code is the canonical shape) |
| **pi** | project `.pi/extensions/align.ts` | yes (`tool_call`) | yes, via the `tool_result` content patch | opt-in, critical retry only | from pi's source |
| **Gemini CLI** | project `.gemini/settings.json` | yes (`BeforeTool`) | yes, on `AfterTool` only | opt-in, critical retry only | from Gemini's docs |
| **OpenCode** | project `.opencode/plugins/align.js` | yes (`tool.execute.before`) | yes, by mutating the result in `tool.execute.after` | opt-in, critical retry only | from OpenCode's source |
| **Codex** | user `~/.codex/hooks.json` ([docs](https://developers.openai.com/codex/hooks)) | yes (`PreToolUse` on `apply_patch`) | yes, `PreToolUse` has `additionalContext` | opt-in, critical retry only | **pending real capture** |
| **Cursor** | user `~/.cursor/hooks.json` ([docs](https://cursor.com/docs/agent/hooks)) | yes (`preToolUse`, matcher `Write`) | yes, on `postToolUse` only (`additional_context`) | opt-in, critical retry only | **pending real capture** |
| **Copilot CLI** | user `~/.copilot/hooks/align.json` ([docs](https://docs.github.com/en/copilot/reference/hooks-reference)) | yes (`preToolUse` on `edit`/`create`/`str_replace_editor`/`apply_patch`) | yes, on `postToolUse` only (`additionalContext`) | opt-in, critical retry only | **pending real capture** |
| **Claude Desktop** | - (MCP only) | no hook API | no | no | - |
| **Windsurf** | - (MCP only) | no hook API | no | no | - |
| **Zed** | - (MCP only) | no hook API | no | no | - |
| **VS Code** | - (MCP only) | no hook API for the CLI to write | no | no | - |

Every host still gets the MCP server and the `AGENTS.md` nudge. The last four do not get the
deterministic layer, and no amount of config on our side changes that.

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

### A user-level hook does not run in the project

Cursor documents that user-level hook scripts run from `~/.cursor/`. The post-edit check
reads `git diff` in the current directory, and the surfaced-decision and verdict stores are
keyed on it too, so a hook started somewhere else would look at the wrong tree, or exit 0 in
silence because `~/.cursor` is not a repository. Every host puts the workspace in the
payload's `cwd`; `align check --advisory` moves there first when it exists.

## The read path: SessionStart injection (ALI-933)

Everything above is the write path: a hook fires when the AGENT proposes an edit. Until
ALI-933 nothing fired on the READ path - the graph's content only reached the model if it
chose to open `.align/decisions.md` or call an MCP tool. `grep -rn
"SessionStart\|UserPromptSubmit" src --include="*.ts"` returned nothing outside this file's
own prose before this ticket. So a claim like "the agent already has the answer" was true
only of the ask-based MCP path, never of a fresh session - MCP tools and resources are both
pull primitives, and no amount of caching that path (ALI-855) makes it unprompted.

The mechanism this ticket ships is the read-path counterpart to the table above: a hook that
fires before the model has done anything, whose return value can inject text into what it
reads - not just approve or deny. Same method as the write-path table: read the runtime's own
docs/source, cite what was actually found, and mark anything unconfirmed as unverified rather
than assumed absent (verification.md, "a positive control proves your check works, not that
your search space is right").

| Host | Pre-prompt/session-start hook exists | Can inject content | Shipped here | Verified against |
|---|---|---|---|---|
| **Claude Code** | yes - `SessionStart` | yes - `hookSpecificOutput.additionalContext` | **yes** | code.claude.com/docs/en/hooks, fetched directly, 2026-09-09 |
| **Gemini CLI** | yes - `SessionStart` | likely, but the exact shape is disputed across Gemini's own docs pages (see below) | no - schema unresolved | geminicli.com/docs/hooks/reference/ and /writing-hooks/ |
| **Codex CLI** | yes - `SessionStart`, `UserPromptSubmit` | yes per docs - `hookSpecificOutput.additionalContext`, same shape as Claude Code | no - needs a new TOML-safe config writer this repo doesn't have yet | learn.chatgpt.com/docs/hooks (redirected from developers.openai.com/codex/hooks) |
| **pi** | `session_start` exists but is side-effect only (cannot inject); `before_agent_start` fires per-turn and CAN inject a message / modify the system prompt | only per-turn, not per-session | no - see "pi: real, but per-turn" below | github.com/earendil-works/pi, `packages/coding-agent/docs/extensions.md`, fetched raw |
| **Cursor** | yes, documented - `sessionStart` + `additional_context` | documented yes, but see "Cursor: documented, unreliable" below | no | cursor.com/docs/hooks (official) + 3 open forum bug reports, Sep 2026 |
| **OpenCode** | **no** - verified absent | - | no | opencode.ai/docs/plugins/, full hook list read; only `experimental.session.compacting` injects text, and only into the compaction prompt, not a live turn |
| **Copilot CLI** | `sessionStart` fires, but its output is explicitly documented as ignored | **no** | no | docs.github.com Copilot CLI hooks tutorial; corroborated by github/copilot-cli#1730 and #2201 (the hook is also unreliable about firing at all) |

Only Claude Code shipped a real writer in this pass. The other five rows are not a shrug -
each has a specific, cited reason it did not ship, and three of them (Gemini, Codex, pi) name
a genuine capability that a follow-up could build on.

### What shipped: Claude Code's SessionStart

`writeClaudeCodeSessionHook` (`src/lib/agent-rules.ts`) merges a `SessionStart` hook into the
same `.claude/settings.json` the write-path hook already owns, running `align context inject`
(`src/commands/context.ts`) - a new, tiny command that reads whatever `align context sync`
last wrote to `.align/decisions.md` and prints it as
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`. It does
**not** call the gateway itself: a hook has to stay fast and offline-safe, and the
fetch+render pipeline already has an owner (`sync`). Fails open at every branch - no
`.align/decisions.md` yet, an unreadable file, a whitespace-only file - by printing nothing,
exactly like the write-path shims print nothing when they find no conflict.

The matcher is `startup|resume|clear|compact|fork` - Claude Code's full documented list of
`SessionStart` sources - rather than omitting `matcher` to mean "all". Omission is unverified
for this event; an explicit alternation is the same idiom `writeClaudeCodeHook` already uses
for `Write|Edit`, and it is verifiable rather than assumed.

**Freshness caveat, stated plainly:** this only delivers whatever was last synced. A user who
never runs `align context sync` gets nothing injected (fails open, correctly), and one who ran
it a week ago gets a week-old snapshot. Fetching live inside the hook was considered and
rejected for this pass - `align context sync`'s own command (`registerContextCommand`) uses a
spinner, exits the process on failure, and needs network + auth, none of which belong inside a
10-second hook window. Wiring `align setup` to also run `context sync` once, or having the
hook trigger a background refresh, are both reasonable follow-ups this ticket does not take.

### Gemini CLI: real hook, disputed output shape

`SessionStart` is documented at geminicli.com and its reference page states the non-blocking
output is `hookSpecificOutput.additionalContext` - identical to Claude Code's. But the
separate `writing-hooks` tutorial page's own worked SessionStart example outputs a *different*
field, `systemMessage`, and shows the hook group requiring an explicit `matcher` (`"startup"`)
where the reference page implies one may not be needed. Two pages on the same docs site
disagree with each other on the one detail that would decide whether a shim actually reaches
the model. Shipping against either guess risks the exact failure this ticket is scoped to
avoid: a config that is "registered but never invoked... silent" the same way a shim can be
(see "Verifying a shim actually fires" below) - except here it would be registered, invoked,
AND printing the wrong field, which is quieter still. Needs a live Gemini CLI install to
settle before a shim is worth writing.

### Codex CLI: real per docs, no TOML writer to build on

`SessionStart` and `UserPromptSubmit` are both documented with the identical
`hookSpecificOutput.additionalContext` shape Claude Code uses, per a single fetch of
learn.chatgpt.com/docs/hooks (the docs.openai.com and github.com/openai/codex/docs/config.md
copies did not surface the hooks reference directly - this is one source, not
cross-confirmed). This is genuinely promising and contradicts nothing this file already says
about Codex: the existing "Codex CLI cannot do it" row above is specifically about
`PreToolUse` covering Bash only, which is a different, older claim about tool interception,
not about session lifecycle. What is missing is infrastructure, not evidence: Codex reads
hooks from `hooks.json` or an inline `[hooks]` table in `.codex/config.toml`, this repo has no
TOML parser dependency today (`grep -n "toml" package.json` - no hits), and a hand-rolled TOML
merge is exactly the kind of "looks fine, corrupts someone's file" risk `writeClaudeCodeHook`'s
JSON-parse-or-throw guard exists to avoid for JSON. A real follow-up, not a shrug: add a TOML
dependency, write `writeCodexSessionHook` following the same merge-and-preserve shape as the
JSON writers, with the same "throw on unparseable existing config" guard.

### pi: real, but per-turn, not per-session

pi's `session_start` extension event exists and fires on `/new` and `/resume`, but per
`packages/coding-agent/docs/extensions.md` it is documented for side-effect setup
(reconstructing extension state, opening a resource) - its return value is not described as
feeding model context anywhere in that doc. The event that CAN inject content is
`before_agent_start`, which "fires after user submits a prompt but before the agent loop
begins" and can "inject a message and/or modify the system prompt" - functionally pi's
`UserPromptSubmit` equivalent, not its `SessionStart` equivalent. Injecting the whole decisions
file on every single turn (as opposed to once per session) is a real design problem, not a
wiring change: it needs an in-extension dedup keyed on something that identifies "already
injected this session", and `before_agent_start`'s documented event shape does not obviously
carry a stable session id to key on. Worth a dedicated follow-up rather than folding into this
one.

### Cursor: documented, unreliable in the field

cursor.com/docs/hooks (the official reference) documents `sessionStart` firing "when a
composer conversation creates" with an `additional_context` output field described as
"Additional context to add to the conversation's initial system context" - on paper, the
closest match to Claude Code's mechanism of anything found. It is not shipped here because
three separate, current (Sep 2026) Cursor forum bug reports describe the same failure: the
hook fires, Cursor's own hooks log confirms the `additional_context` was accepted and merged,
and the content still never reaches the model - "Agent ignores sessionStart hook context even
when Hooks log says it merged successfully", "sessionStart hook additional_context is never
injected into agent's initial system context", "sessionStart hook output is accepted and
merged, but the injected context does not reach Agent Window". A shim that is registered,
fires, and gets swallowed downstream is worse than no shim: it would read as delivered and
would not be, exactly the "a control that reads as protection and isn't" trap. Revisit once
one of those threads closes as fixed.

### Copilot CLI: verified absent

Not in the write-path table above at all - `align-cli#86` never covered it. For the read path:
GitHub's own Copilot CLI hooks tutorial states the `sessionStart` hook "receives contextual
information such as the current working directory and the initial prompt" but "any output from
this hook is ignored by Copilot CLI, which makes it suitable for informational messages" -
i.e. it is documented as observation-only, the same shape Cursor's `afterFileEdit` already is
in the write-path table. Two open upstream issues (github/copilot-cli#1730, #2201) additionally
report the hook not firing reliably at all. Confirmed absent for this purpose on both counts.

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
