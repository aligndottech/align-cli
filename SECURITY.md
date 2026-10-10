# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately via GitHub's **"Report a vulnerability"** button on the
[Security tab](https://github.com/aligndottech/align-cli/security/advisories/new)
of this repository. If you cannot use GitHub Security Advisories, email
**security@align.tech**.

We aim to acknowledge reports within a few business days and will keep you updated
on the fix and disclosure timeline.

## Scope

This repository is the open-source Align CLI and MCP server (`@aligndottech/cli`).

- The CLI connects to your tools **read-only** and stores data either in your own
  personal Align cloud tenant or, with `--local`, in a SQLite database on your
  machine. In `--local` mode the CLI never sends your decisions to Align. What does
  use the network there: a one-time embedding-model download from huggingface.co;
  read-only calls to whichever tools you import from, using the token you supply;
  and, when an AI provider is available (an API key, or a running Ollama, which
  needs none and honours `OLLAMA_HOST`), `align ask`, `align check` and the MCP
  `align_check_alignment` tool calling that provider.
  [docs/local-mode.md](docs/local-mode.md) covers this in detail.
- The hosted Align gateway/graph is a separate service; vulnerabilities in the
  hosted product should also be reported through the channel above.

## Supported versions

We support the latest published version on npm. Please upgrade to the latest
release before reporting, in case the issue is already fixed.

## Sharing from inside a coding agent (`align_share`)

`align share` sends decisions from your local graph, and your judgements on them, to your team's
graph. It prints exactly what leaves the machine, names the workspace and account, and asks first.
Nothing is sent without a yes. A credential-shaped string in a title, summary, URL or note is
refused on this machine, and again by the server.

`align_share` (the MCP tool) only PREPARES a share: it returns the preview and a one-time code, and
cannot send. You finish it with `align share --confirm <code>` in your own terminal, where the preview
is shown again and the answer defaults to No. The code works once, expires after 10 minutes, and is
refused if the decision or its judgements changed after the preview.

> An agent-initiated share is confirmed on the machine the agent runs on, in a terminal. An agent
> with shell access could allocate a pseudo-terminal and answer the terminal prompt itself. This
> stops accidental or tool-only shares, not a determined agent with a shell. Every share is still
> previewed, attributed to the signed-in user, and retractable (`align share --retract`). The
> follow-up, browser confirmation on the team graph, closes the gap.
