# Align CLI

[![npm version](https://img.shields.io/npm/v/@aligndottech/cli.svg)](https://www.npmjs.com/package/@aligndottech/cli)
[![CI](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/@aligndottech/cli.svg)](https://nodejs.org)

**Your AI agents know the code. They don't know the company.**

Decisions get made in commits, tickets, chat and meetings. A few months later nobody can say
which ones still stand, and your coding agent has no chance. Align pulls those decisions into one
graph and has your agent check it before it writes code.

```bash
curl -fsSL https://align.tech/install.sh | sh
align
```

Run it inside a git repository. The first time, `align` asks which coding agent you use, builds a
graph from your commit history and wires your agent up to it. After that, `align` opens your agent
with the graph already connected, and refreshes your connected sources in the background, at most
every 15 minutes per source (`align sync --off` turns that off).

MIT licensed, no account needed. It's in beta, pre-1.0.

## Install

- **macOS and Linux:** the `curl` line above. It installs a standalone binary, so you don't need
  Node. It checks the download against the release checksums and tells you if it can't. You can read
  [install.sh](install.sh) before you run it.
- **npm:** `npm install -g @aligndottech/cli` (Node 22.16+).
- **Windows:** use npm in PowerShell. The `curl` line needs a POSIX shell, so it only works under
  Git Bash or WSL. With no Node, download `align-windows-x64.exe` (or `-arm64`) from the releases
  page, rename it to `align.exe` and put it on your `PATH`.

Binaries for every platform are on the
[releases page](https://github.com/aligndottech/align-cli/releases/latest).
More in [docs/installation.md](docs/installation.md).

## Local-only mode

The local graph is a SQLite file on your machine, and embeddings run on-device. In local-only
mode your decisions and code never go to Align. Team graphs are different: they're hosted by
Align, or self-hosted, so the team can share them.

In local-only mode the CLI sends anonymous usage counts. It tells you once before the first one,
and sends nothing from CI. Logged in to a team graph, usage events go over the connection you're
already using, and they're on unless you turn them off. Either way, `align telemetry off` stops
them. [What touches the network](docs/local-mode.md) and [every field we send](docs/telemetry.md).

## How it works

1. **Import.** Align reads decisions out of the tools you already use: Git, GitHub, GitLab, Jira,
   Confluence, Linear, Notion, Slack, Teams and Zoom. Read-only, it never changes anything there.
2. **Link.** It records what was decided, why and by whom, and how decisions relate: what
   replaced what, and what conflicts.
3. **Check.** Your agent queries the graph and gets checked against it, over MCP, an edit hook, CI
   or `align ask`.

## How your agent uses it

`align setup` wires Align in four ways, so the check happens whether or not the model thinks to
ask.

| | What you get |
|---|---|
| **MCP server** | Claude Code, Cursor, Claude Desktop, VS Code, Windsurf, Zed, Codex, Copilot CLI, Gemini CLI, pi and OpenCode can query the graph |
| **Edit hooks** | Every edit is checked against past decisions as it happens. Claude Code, pi, Gemini CLI, OpenCode, Codex, Cursor and Copilot CLI |
| **Editor rules** | A managed block in `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/align.md` |
| **Shared `.mcp.json`** | One committed file sets up the whole team |

The hook never blocks an edit unless you turn that on. If Align is missing, slow or down, the
edit goes ahead untouched. It doesn't need an AI key unless you turn blocking on.

Cursor, Copilot CLI and Gemini CLI can only pass the result to the model after the edit lands.
That's a limit of their hook APIs. Codex, Cursor and Copilot CLI get their hooks from a user-level
file (`~/.codex/hooks.json`, `~/.cursor/hooks.json`, `~/.copilot/hooks/align.json`), and none of
those three has been checked against a real session's payload yet.
[Per-host details](docs/agent-hooks.md).

The first time Claude Code opens a project with a committed hook, it asks you to approve it.
Accept, or the hook won't run.

## Commands

```bash
align                                # set up, or see your graph and what to do next
align ask "how does our auth work"   # an answer, with sources
align ask src/auth/session.ts        # decisions about a file
align connect                        # pick a source to import: git, docs, jira, github, ...
align connect jira --token ...       # import one source directly
align check                          # check your staged diff against the graph
align mcp --setup                    # wire your agent to the graph
```

That's all of `align --help`. The rest (`search`, `decisions`, `export`, `ratify`, `push`,
`context`, `local`, ...) still work and are in [docs/commands.md](docs/commands.md).

Inside your agent, the agent writes the answers, so Align doesn't need an AI key there. Only
`align ask` in a terminal writes its own answer. Give it a key (Anthropic, OpenAI, OpenRouter,
Gemini, Groq, Mistral or xAI), a local Ollama, or any OpenAI-compatible endpoint. Without one, it
lists the matching decisions instead, and offers to set up a free Groq key (no card). With
several, `align ai` picks which one is used. [Setting one up](docs/configuration.md#ai-provider).

## Teams

Team graphs are separate from the local one. Run `align login`, then `align setup`. A work email
puts you in your company's graph: the first person in is the admin, and colleagues on the same
domain join it automatically. Setup connects your tools with read-only OAuth and wires up your
editors.

A personal email doesn't get a cloud graph, so solo use is the local graph. Logging in never
switches you to local mode behind your back. `align setup --env local` builds the local graph and
leaves your login alone. [Joining your team](docs/join-your-team.md).

## Docs

| | |
|---|---|
| [Installing](docs/installation.md) | npm, the binary, Windows |
| [Join your team's graph](docs/join-your-team.md) | `align join`, hosted and self-hosted |
| [Importing](docs/importing.md) | Every source, tokens, flags |
| [Alignment check](docs/check.md) | Modes, exit codes, CI, the GitHub Action |
| [Cloud or local-only](docs/local-mode.md) | What runs where, what touches the network |
| [Telemetry](docs/telemetry.md) | Every event and field, and how to turn it off |
| [MCP server](docs/mcp.md) | Editor config, the tools your agent gets |
| [Configuration](docs/configuration.md) | AI providers, env vars, auth, self-hosting |
| [Agent hooks](docs/agent-hooks.md) | What each host can and can't do |
| [Choosing an access path](docs/access-capability.md) | API, CLI JSON or MCP, and why |
| [All commands](docs/commands.md) | Full reference |

## Why

In a published study, giving a coding agent the product decisions on record took decision
compliance from 46% to 95%
([Dillon & Varanasi, arXiv:2605.08112](https://arxiv.org/abs/2605.08112)). It's a small vendor
study, 8 tasks and 41 decision points, and it isn't our data.

Wiring context into an agent is the easy part, and this repo is the open-source version of that.
The hard part is the record underneath: what your team actually decided, across every tool, kept
up to date.

If you want a hand setting it up, I do free 30-minute setup calls:
https://calendly.com/tom-align/setup

## License

MIT, see [LICENSE](./LICENSE). The CLI, the MCP server and the
[connector SDK](https://github.com/aligndottech/align-connector-sdk) are open source. The hosted
team product is a separate commercial service.
