# Session fixtures (ALI-808)

Tom's ruling on ALI-808 (2026-09-03): "install Codex CLI, Gemini CLI, opencode and Cursor
(all free), run one real session in each, commit the session file(s) under the reader's test
fixtures, and no adapter ships without one... The gate is the fixture, not the agent name."

## What's here, and how it was captured

| Agent | Fixture | How | Verified |
|---|---|---|---|
| `claude-code` | `claude-code/main-red-fix-decision.jsonl` | A real local session transcript (`~/.claude/projects/`), trimmed to the four turns around one `AskUserQuestion` call - the surrounding turns (unrelated tool calls, an MCP graph search) were cut because they carry no signal for this reader and the MCP search result quotes production graph content that shouldn't be republished in a fixture. All kept content (question, options, the chosen answer) is verbatim. | Yes |
| `pi` | `pi/kubectl-guard-check.jsonl` | A real local `pi` session (`~/.pi/agent/sessions/`), committed unmodified. Confirms the same finding the original ALI-607/808 research made: pi's real tool vocabulary here is `bash` only - no structured question/choice tool. | Yes |
| `codex` | `codex/retry-policy-decision.jsonl` | A real `codex exec` run (Codex CLI 0.153.0, authenticated via `codex login --with-api-key`) against a throwaway repo, given a decision-shaped prompt ("decide the retry count for failed webhook deliveries"). Committed unmodified except the scratch working directory path, replaced with a placeholder throughout. | Yes |
| `opencode` | `opencode/retry-policy-decision.sql` | A real `opencode run` (opencode-ai 1.18.27) against the same throwaway repo and prompt. opencode's real storage is SQLite (`~/.local/share/opencode/opencode.db`, since v1.2.0) - this is a SQL dump of the `project`/`session`/`message`/`part` schema plus every row for that one real session, so the adapter test loads it into a fresh `node:sqlite` database rather than parsing a text format opencode doesn't actually use. Content is real; only the scratch directory path was replaced with a placeholder. |Yes |
| `gemini-cli` | none | Blocked: Gemini CLI's headless mode (`gemini -p`) refused with "Please set an Auth method... GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA" - none of those were available in this environment, and the alternative is an interactive browser OAuth login this session cannot complete. | **No** |
| `cursor` | none | Blocked two ways: Cursor's real product is a GUI IDE with no headless CLI reachable from this environment (the `cursor-agent` npm package is an unrelated third-party tool, not Cursor's own); and running Cursor's own installer (`curl https://cursor.com/install \| bash`) was refused by this session's own permission guard as a pipe-to-bash pattern, which is the right call for an unreviewed remote script regardless of credentials. No `CURSOR_API_KEY` was available either. | **No** |

## What this means for the two blocked agents

Per Tom's own gate, `gemini-cli` and `cursor` do **not** ship a `parseSession` implementation in
this PR. Each has a `locateSessionFiles` built from the documented storage path (see the table
in the ALI-808 ticket description) - that part is low-risk and independently testable without
knowing the exact content format. `parseSession` throws `SessionFormatUnverifiedError` naming
this file, rather than guessing at a shape nobody has confirmed against a real session; a wrong
parser that reads as working is worse than an honest "not yet".

Follow-up: capture a real session for each (an interactive Gemini CLI login, and either a Cursor
account or someone who already has the desktop app installed), replace this note, and fill in
`parseSession`.

## Scrubbing

Every fixture here had its capture-time scratch/temp directory path replaced with a placeholder
(`/home/user/...`) before committing. No fixture contains an API key, account id, or personal
data - each was checked by hand before committing (see the session in this same conversation for
the exact greps run). The Claude Code fixture specifically omits the two MCP tool calls that were
part of the original real session (an `align_prod` graph search) because their results quote
production decision-graph content unrelated to what this reader parses.
