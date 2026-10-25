# Your first session

You ran `align`, it found decisions in your history, and your agent is connected. Here is how
to see that working, in three prompts. Type them into your agent (Claude Code, Cursor, Codex,
...), not into the terminal. The end of setup prints the same three, filled in from your own
repo.

## 1. Ask why

> why did we switch to postgres?

Use a decision from the "Found in your history" box. The agent looks it up in the graph and
answers with the reason and where it came from: a commit, a PR, a ticket. Good answers quote
the source. If the answer is "Align has no record", the reason was never written down
anywhere Align reads, and `align connect` can add the place it lives (PR descriptions, Jira,
Slack ...).

## 2. Ask before you touch a file

> what was decided about src/db/pool.ts?

Pick a file you are about to change. The agent finds the decisions related to it, so you know
the constraints before you start, not in review.

## 3. Watch it push back

> Plan a change that reverses "switch to postgres". Check it with Align before writing anything.

Use the same decision as in prompt 1. The agent checks the plan against the graph, finds the
decision it goes against, and stops to tell you instead of writing the change. This is the
same check that runs on its own when the agent edits code. Asking for a plan means nothing is
written.

You don't need an AI key for this. Inside your agent, the agent itself reads the decisions
Align found and judges whether the plan goes against them.

## How do I know the check is running?

When the agent edits a file, hooks check the edit against your graph, before it is written
and again after it lands. When the check finds a related decision, the agent says so in one
line, such as:

> Align: checked against "Every webhook verifies its signature" - this change agrees.

If you never see a line like that:

- **Claude Code:** it asks once to approve the project hooks in `.claude/settings.json`. If you
  declined, the hooks don't run. Run `/hooks` in Claude Code to check.
- **Nothing related:** the check stays silent when nothing in the graph relates to the edit. A
  small graph has little to relate to, so `align connect` adds more sources.
- **Anything else:** `align doctor` checks that the graph answers, and
  [Agent hooks](agent-hooks.md) has what each agent can and can't do.

## Next

- `align connect` adds a source: GitHub PRs, Jira, Linear, Slack, Notion and more.
- `align check` runs the same check on your staged changes from the terminal, or in CI
  ([Alignment check](check.md)).
- Bare `align` shows your graph and opens your agent with it connected.
