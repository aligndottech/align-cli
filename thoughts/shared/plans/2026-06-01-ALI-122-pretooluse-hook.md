# ALI-122: PreToolUse advisory hook (catch conflicts before an edit is written)

Follow-up to ALI-121 (PostToolUse advisory). ALI-121 catches a conflict AFTER an edit
lands. ALI-122 adds the same deterministic check one step earlier: a Claude Code
PreToolUse hook (matcher Write|Edit) that inspects the PROPOSED edit before it is written
and surfaces conflicting decisions, so the agent can reconsider before the change exists.

## Design

One advisory entrypoint, branching on the Claude Code hook payload it gets on stdin.

- `src/lib/hook-payload.ts` (new): `readHookPayload(stream?)` reads the JSON Claude Code
  pipes to a hook on stdin and returns `{ hook_event_name, tool_name, tool_input }` or
  null (TTY / empty / invalid). Injectable stream for tests; never hangs (short timeout).
- `src/lib/advisory-dedup.ts` (new): per-project-dir marker file (tmpdir, 20s TTL) of the
  decision ids surfaced recently, so the pre and post hooks do not show the agent the same
  conflict twice. `recentlySurfaced(cwd)` + `markSurfaced(cwd, ids)`.
- `src/commands/check.ts` (modify): `runAdvisory` reads the payload. PreToolUse -> check
  the proposed content (Write: tool_input.content; Edit: new_string; MultiEdit: joined
  new_strings) and emit a PreToolUse output. Otherwise -> today's git-diff PostToolUse
  behaviour. Both race the gateway against ADVISORY_TIMEOUT_MS, fail open, always exit 0,
  and filter out ids surfaced by the sibling hook moments ago.
  - Default PreToolUse output: `hookSpecificOutput.additionalContext` only (NO
    permissionDecision, so normal permission flow is untouched, just enriched).
  - New `--block-on-critical` opt-in: on a CRITICAL conflict, emit
    `permissionDecision: "deny"` + reason. Default never blocks.
- `src/lib/agent-rules.ts` (modify): `writeClaudeCodeHook` writes the align group into BOTH
  `PreToolUse` and `PostToolUse` (same command `align check --advisory`, which self-detects
  the event from stdin), idempotently. Managed CLAUDE.md block + cursor rule mention the
  pre-edit check.

## Tests (TDD, behaviours)
- hook-payload: parses Write / Edit / MultiEdit payloads; null on TTY / empty / bad JSON.
- advisory-dedup: mark then recently-surfaced returns ids; expires after TTL; per-cwd
  isolation; merges across runs in-window.
- check-advisory (extend): mock hook-payload + dedup. PreToolUse + conflict -> PreToolUse
  additionalContext with the title, exit 0, checkAlignment called with the proposed content;
  --block-on-critical + critical -> deny; aligned -> no output; dedup-hit -> no output.
  Existing PostToolUse/git-path tests unchanged (payload mocked null).
- agent-rules (extend): both PreToolUse and PostToolUse align groups written; idempotent in
  both; unrelated hooks preserved.

## Validation note
The exact PreToolUse output contract (additionalContext vs permissionDecisionReason) needs a
manual check against live Claude Code (flagged in the ticket). Tests lock our emitted shape;
the live behaviour is a manual smoke step before merge.
