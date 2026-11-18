# SessionStart payloads, as the vendor docs show them

These are NOT captures. Read 2026-11-18: the hook file for each host was written, but
no real session fired it on the machine this was written on (Codex 0.153.0 ignores a hooks file
until an interactive trust review, and `codex exec` never asks; Gemini CLI had no auth; Copilot CLI
was not installed). So each file here is the documented shape, cited below, and the tests that
use it say so. Replace a file with a real capture, redacted, when one exists. The recipe is in
`../hook-payloads/README.md`; point the host's `SessionStart` / `sessionStart` hook at `tee`.

| File | Source |
|---|---|
| `codex-session-start.json` | learn.chatgpt.com/docs/hooks (common fields, `source`, `permission_mode`) |
| `gemini-session-start.json` | geminicli.com/docs/hooks/reference (`source`, base fields) |
| `copilot-session-start.json` | docs.github.com/en/copilot/reference/hooks-reference (camelCase input) |
