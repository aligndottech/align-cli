# ALI-121: PostToolUse hook + CLAUDE.md/Cursor nudge for auto-alignment

Follow-up to ALI-120 (MCP server instructions). ALI-120 made agents *able* to use
Align proactively, but it's still model discretion. ALI-121 adds the **deterministic
layer**: a Claude Code hook that fires regardless of model choice, plus committed
agent-rules files so the nudge ships with the repo.

## Requirements (from ticket)

1. `align check --advisory` mode: always exit 0, emit `hookSpecificOutput.additionalContext`
   JSON on stdout. Distinct from the existing pre-commit `--hook` (which can fail).
   Fail-open (gateway down/slow -> exit 0, no output), tight timeout, non-blocking.
2. `align setup` writes a Claude Code PostToolUse hook (matcher `Write|Edit`) into the
   project `.claude/settings.json` that runs `align check --advisory`.
3. Append a concise, managed (marker-delimited, idempotent) nudge to project `CLAUDE.md`
   and write `.cursor/rules/align.md` (Cursor doesn't honor Claude Code hooks).
4. Idempotent re-runs of `align setup`. Document the one-time "approve hooks" prompt.

## Design

### Part 1 - `align check --advisory` (src/commands/check.ts)
- New `--advisory` option.
- Not a git repo / no diff -> exit 0, no output.
- Diff source: `getHeadDiff()` (`git diff HEAD`) - captures the just-edited tracked files.
- Race `checkAlignment` against a tight timeout (`ADVISORY_TIMEOUT_MS`). On timeout or
  any error -> exit 0, no output (fail-open).
- On `status === 'conflicting'` -> build a concise context string from the conflicts and
  print `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`
  to stdout, then exit 0. Otherwise exit 0 silently (no noise on aligned/no-context).

### Part 2 - agent-rules lib (src/lib/agent-rules.ts)
Pure fs helpers, unit-tested against a tmpdir; mocked in setup.test.ts.
- `writeClaudeCodeHook(cwd, env?)`: merge a `PostToolUse` group (matcher `Write|Edit`,
  command `align check --advisory[ --env <env>]`, `timeout` seconds) into
  `.claude/settings.json`. Idempotent: strip any existing align-check advisory group
  first, throw on invalid JSON (mirrors writeMcpConfig).
- `writeManagedNudge(cwd)`: replace content between `<!-- align:start -->` /
  `<!-- align:end -->` markers in `CLAUDE.md`, or append the block (create file if absent).
- `writeCursorRule(cwd)`: overwrite `.cursor/rules/align.md` (managed file).
- `setupAgentAlignment({ cwd, env })`: run all three, return what was written.

### Part 3 - wire into setup (src/commands/setup.ts)
- Call `setupAgentAlignment` in both cloud (`runCloudSetup`) and local (`runLocalSetup`)
  paths, right after the MCP editor step. Log the files written + the one-time
  "approve hooks" note. Mock `../lib/agent-rules.js` in setup.test.ts (like mcp-setup.js).

## Tests (TDD, behaviors)
- check.test.ts (advisory): conflict -> hookSpecificOutput JSON + exit 0; gateway error
  -> exit 0 + no stdout; not-a-git-repo -> exit 0 + no stdout; aligned -> exit 0 + no JSON.
- agent-rules.test.ts: hook JSON shape + matcher; idempotent re-run (no dup groups);
  env passed into command; managed nudge marker replacement (no duplication); cursor rule
  written; invalid settings JSON throws.
- setup.test.ts: setup calls setupAgentAlignment (cloud + local).
