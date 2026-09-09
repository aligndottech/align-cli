# Real hook payload captures

Drop the JSON a host actually piped to its hook here, one file per host and event, named
`<host>-<pre|post>.json` (for example `codex-pre.json`, `cursor-pre.json`, `copilot-pre.json`).
`hook-payload-user-hosts.test.ts` loads every `*.json` in this directory and asserts the
normaliser extracts a non-empty proposed change from each pre-edit payload. While the
directory is empty that suite skips and says so.

A hand-written file does not belong here. The point of a capture is that it was produced by
the host, with whatever field names and nesting it really uses, which is exactly the part a
reader of the vendor docs gets wrong (`.claude/rules/tdd.md` in align-stack, "dropping to a
constructed input is the wrong repair").

## How to capture one

Point the host's hook at `tee` instead of `align`, make one file edit in a session, then copy
the payload here and put the real hook back (`align mcp --setup` rewrites it).

```jsonc
// ~/.codex/hooks.json
{ "hooks": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "tee -a /tmp/codex-hooks.jsonl" } ] } ] } }

// ~/.cursor/hooks.json
{ "version": 1, "hooks": { "preToolUse": [ { "command": "tee -a /tmp/cursor-hooks.jsonl" } ] } }

// ~/.copilot/hooks/capture.json
{ "version": 1, "hooks": { "preToolUse": [ { "type": "command", "bash": "tee -a /tmp/copilot-hooks.jsonl" } ] } }
```

Redact `session_id` / `sessionId`, `transcript_path` and any real path or email before
committing; keep every other field and its nesting exactly as sent.
