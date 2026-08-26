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
  use the network there: a one-time embedding-model download from huggingface.co,
  and, when an AI provider is available (an API key, or a running Ollama, which
  needs none and honours `OLLAMA_HOST`), `align ask`, `align check` and the MCP
  `align_check_alignment` tool calling that provider. The README's "Cloud or
  local-only" section covers this in detail.
- The hosted Align gateway/graph is a separate service; vulnerabilities in the
  hosted product should also be reported through the channel above.

## Supported versions

We support the latest published version on npm. Please upgrade to the latest
release before reporting, in case the issue is already fixed.
