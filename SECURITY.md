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

There is no `--yes`: a share needs an answer typed at a terminal. Every path (a plain `align share`, and
`align share --confirm <code>`) shows the preview on the controlling terminal (`/dev/tty`, or `CONIN$` on
Windows, which must pass an is-a-terminal check) and asks with a default of No. A process with no
controlling terminal, such as an agent's shell tool, a hook or a pipe, is refused and sends nothing.
`align share` also refuses when `ALIGN_WRAPPED` is set (you are inside an agent that `align` launched) and
points you to a normal terminal. **That check is a speed bump, not a lock**: an agent can unset the variable.

`align_share` (the MCP tool) only PREPARES a share: it returns the preview and a one-time code, and
cannot send. Its result does not hand the agent a command line; it tells the agent that the person must run
the share in their own terminal and that the agent must not. The code works once, expires after 10 minutes,
and is refused if the decision, its judgements, the workspace or the gateway changed after the preview.
Asking again for the same payload returns the same live code.

> **What this does NOT stop.** An agent that can run commands as you can allocate its own pseudo-terminal
> (for example with `script`), read the preview from it and type the answer, so it can complete a share
> without you. No control inside a local CLI can prevent that, because the agent controls both ends of the
> terminal. Until the planned browser (out-of-band) confirmation on the team graph exists, **the remaining
> control is your agent harness's own approval prompt for shell commands**: do not auto-approve
> commands that run `align share` or open a pseudo-terminal. A share is always previewed and attributed to
> the signed-in user. It can usually be retracted with `align share --retract`, but not always: a share that
> matched an existing team decision, or was recorded as not yours, cannot be retracted from here, and the
> judgements it carried stay on the team graph.
