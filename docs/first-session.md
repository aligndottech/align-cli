# Your first session

You ran `align`, it found decisions in your history, and your agent is connected. Here is how
to see that working, in three prompts. Type them into the agent bare `align` opens, or into
Claude Code, Cursor, Codex and the others, not into your shell. The end of setup prints the same
three, filled in from your own repo, once it has found at least one decision.

## 1. Ask why

> why did we switch to postgres?

Use a decision from the "Found in your history" box. The agent looks it up in the graph and
answers with the reason and where it came from: a commit, a PR, a ticket. Good answers quote
the source. If the answer is "Align has no record", the reason was never written down
anywhere Align reads. The first run already reads the repo's commits, its docs and the recent
merged PRs of a public GitHub repo. `align connect` can add the place it lives (older or private
PRs, Jira, Slack ...).

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

You don't need an AI key in Claude Code, Cursor, Codex and the other agents: the agent itself
reads the decisions Align found and judges whether the plan goes against them. Align's own agent
(bare `align`) runs on a key, Ollama or your Claude Code; setup offers to set one up.

## How do I know the check is running?

When the agent edits a file, the hook checks the edit against your graph. On Claude Code the
check runs before the edit is written. That is recorded in headless runs only, and interactive
sessions are not tested. Cursor, Copilot CLI and Gemini CLI hand the result to the model after the
edit lands. See [hook coverage](hook-coverage.md). When the check finds a related decision, the agent says so in one
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

## Which agent runs

Run it in a git repo. The first run builds a graph from your commit history, the repo's ADRs and RFCs, decision logs,
CLAUDE.md, AGENTS.md, tenets and architecture docs, and the recent merged pull requests of a GitHub repo it can read that give
a reason. Then the first `align` in a repo asks how you want to use Align:

```text
Align found Claude Code on this machine. How do you want to use Align?
1. Keep Claude Code. Align checks edits and answers questions inside it.
2. Use Align's own coding agent.
Change this later: align --switch
```

"Keep" is preselected when Claude Code, Codex or Cursor is installed, and it wires Align into
that agent the way `align mcp --setup` does, after listing the files and asking. With none of
the three installed, option 2 is preselected. Align remembers the answer for that repo, so
later runs don't ask. `align --switch` asks again. After a "2", `align` opens Align's own
coding agent over that graph. Either way, connected sources refresh in the
background when you start `align`, at most every 15 minutes per source (`align sync --off` turns that off).

If you choose Align's own agent, you choose what runs behind it:

- **Your own API key** (Anthropic, OpenAI, Gemini and others, set with `align ai`), or a local
  model through Ollama.
- **Your own Claude Code.** Anthropic does not let other apps use a Claude subscription, so with
  no key Align drives your installed Claude Code and you stay on your plan. Align never sees your
  Claude login.

`align --engine align` or `align --engine claude` picks one, and Align remembers it. Edits are
checked against the graph before they are written. An edit that rewrites lines a decision wrote
waits for you to allow it or stop it.

Prefer your agent's own interface? `align -- <args>` still opens it with the graph connected.

## Try it on a repo you didn't write

Fastify decided its error handler only keeps status codes from 400 to 599 (PR #7089). Nothing
in the code says why. Ask your agent to undo it and see what happens:

```bash
git clone https://github.com/fastify/fastify && cd fastify
align                     # builds the graph from git history, then opens Align
```

Then, in Align:

```text
Errors with a 1xx-3xx statusCode currently fall back to 500.
Change lib/error-status.js so they keep their status code.
```

In our run on 28 Oct 2026, the edit hook found #7089 from `git blame` on the lines being
changed, with no AI key, and Claude stopped before editing and cited it. On 4 Nov 2026, on
0.66.1, Claude asked Align over MCP before it tried an edit, so the hook never fired. It cited
#7089 and #601 (2018: "do not allow set status code to lower than 400"), changed nothing, and
asked what to do. Models are not deterministic, so your run may word it differently.

On 6 Nov 2026 we ran the same prompt in Align's own agent, once on Claude Code and once on an
OpenAI key. Both times the agent tried the edit, Align found #7089 from `git blame` and asked
first, and after "stop" the agent cited #7089 and changed nothing.

## Imported decisions show `ratified: false`

Imported decisions show `ratified: false`. That is expected, and you don't have to ratify them.
Ratifying is a person saying "this governs", and it only applies to a claim an agent made, such as
one from `align connect sessions` (`align decisions list --unratified` lists them). A rule your team
ratified is the one thing that can block an edit without an AI key.

## Tickets from a decision

To make tickets from a decision, ask your agent: "make tickets for that decision". It shows you the plan first
(tracker, team, the task titles) and creates nothing until you say yes. `align backlog` does the same from a terminal.

## What happens after you install

1. **Run `align` in a repo.** It reads your commits, ADRs and RFCs, decision logs, `CLAUDE.md`,
   `AGENTS.md` and recent merged PRs, and builds the graph in `~/.align/local.db`. Nothing to fill in.
2. **Pick your agent.** Keep Claude Code, Codex or Cursor, or use Align's own. Setup lists the files
   it will write and asks first.
3. **Work as normal.** On Claude Code, edits are checked against the graph before they are written. Cursor, Copilot CLI and Gemini CLI hand the result to the model after the edit lands ([hook coverage](hook-coverage.md)). The agent
   can ask the graph why something is the way it is. You do nothing by hand.
4. **Sources refresh when you start `align`**, in the background, at most every 15 minutes per source. There is no timer: if you only open your agent, nothing refreshes until you run `align` or the agent calls `align_sync` (`status` shows where it stands, `run` starts a refresh). A big GitHub repo backfills its pull-request discussions over several runs.
5. **Add more sources when you want them:** `align connect` (Jira, Linear, Slack, Notion and more).

**Prefer a file you control, and no MCP?** Run `align up` in the repo. It reads the commits and docs, refreshes any
connected source, and writes the decisions to `.align/decisions.md`, imported from your CLAUDE.md. It works on your local graph, and sends nothing to a cloud environment unless you name one with `--env` or `ALIGN_ENV`. When every decision
in it comes from the repo itself (its commits, docs and pull requests), it is a normal file you commit. Run `align up`
again whenever you want it current. Your CLAUDE.md needs to exist for the import line to be added; without one,
`align up` prints the line to add. If you connect a chat or ticket tool, or a decision comes from another repo or a doc
that is not committed, the file stays out of git, because it then holds private content. A file you already committed
stays tracked until you run `git rm --cached .align/decisions.md`, and `align up` tells you when that applies.
