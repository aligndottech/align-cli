# Align CLI for Claude

Your coding agent knows the code. It does not know what your team already decided: the ADR that
ruled out a library, the pull request that settled a pattern, the ticket that changed a limit.
This plugin teaches Claude to check before it changes code, and to stop and ask you when a
recorded decision conflicts with what it is about to do.

## What it contains

- **A skill, `check-decisions`.** Before Claude edits code for a task, it runs `align ask` to find
  what was decided about that change. After it edits and before it commits, it runs
  `align check` to compare the change with the recorded decisions. When a decision conflicts, it
  stops, shows you the decision, why it conflicts and where it was made, and asks which to follow.
- **A command, `/align-cli:check`.** Runs the same check on demand and reports the result.

The plugin contains only these two instruction files. It has no hooks, no MCP server and no
scripts, and it installs nothing.

## What you need

The [Align CLI](https://github.com/aligndottech/align-cli), installed and set up in your
repository. If it is missing, Claude tells you so and does not install it. The CLI is open source
(MIT), and its README explains how to install it and how it imports decisions from your ADRs,
docs, git history, pull requests and tickets.

## What leaves your machine

The plugin itself sends nothing. It only tells Claude to run the `align` commands above, on your
machine.

The Align CLI, in its default local mode, keeps your decisions in a file on your machine. Two
things can leave it:

- **Anonymous usage counts**, sent to Align. They never contain code or decision text. Turn them
  off with `align telemetry off`, or set `DO_NOT_TRACK=1`.
- **A request to your own AI provider**, when `align check` needs a model to judge a possible
  conflict. It uses the provider key you configured, or a local model. Align does not receive it.

Nothing is sent to Align's hosted service unless you choose to sign in to an Align account or run
`align share`. The plugin does neither.

[Every field the CLI sends](https://github.com/aligndottech/align-cli/blob/main/docs/telemetry.md)
· [Privacy policy](https://align.tech/privacy) · [Terms](https://align.tech/terms)

## Support

Report a problem or ask a question in
[GitHub issues](https://github.com/aligndottech/align-cli/issues).
