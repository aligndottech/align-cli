---
description: Check changes against the Align decision graph
alwaysApply: true
---

# Align decision graph

This project is connected to Align via the `align` MCP server - the source of truth for
what was decided, why, and by whom across Slack, Jira, GitHub, Linear and more.

- BEFORE writing or changing non-trivial code, call `align_check_alignment` with the
  proposed change. A "conflict" means a past decision opposes it - reconcile or confirm
  with the user before proceeding.
- When unsure about a convention or "why" something is the way it is, call `align_ask` first.

(Cursor does not honor Claude Code hooks, so this rule is the Cursor-side nudge.)
