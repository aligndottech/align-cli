# Align CLI

[![npm version](https://img.shields.io/npm/v/@aligndottech/cli.svg)](https://www.npmjs.com/package/@aligndottech/cli)
[![CI](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/@aligndottech/cli.svg)](https://nodejs.org)

**Your AI agents know the code. They don't know the company.**

The decisions behind the code live in commits, tickets, chat and meetings. Months later nobody
can tell what still stands, what conflicts, or why. Align pulls them into one graph your agents
check before they build.

```bash
curl -fsSL https://raw.githubusercontent.com/aligndottech/align-cli/main/install.sh | sh
align setup --local
align ask "why do we use postgres"
```

A standalone binary. No Node, no npm, nothing else to install, and local-only mode works
fully - on-device embeddings included, running on a WASM backend bundled inside the binary.
Linux, macOS and Windows, x64 and arm64, glibc and musl. Verified against the release's own
checksums, and you can read [install.sh](install.sh) before you pipe it anywhere.

Prefer npm, or already have Node? `npm install -g @aligndottech/cli` (Node 22.16+).
Binaries for every platform are on the [releases page](https://github.com/aligndottech/align-cli/releases/latest).

MIT. No account needed. Beta, pre-1.0.

Run it inside a git repository. `--local` seeds the graph from your commit history, so you have
something to ask about straight away, and your decisions stay in a SQLite file on your machine.
Nothing is sent to Align. [What touches the network](docs/local-mode.md).

Want sync across machines and cross-tool relationship detection? Drop the flag. `align setup`
logs you in, connects your tools via read-only OAuth, and wires up your editors.

## How it works

```
  Your tools                      Align                       Your agents & you
  ──────────                   ───────────                  ───────────────────
  Git, GitHub, GitLab  ─┐                                  ┌─ align ask "why…"
  Jira, Confluence      ├─▶  import  ─▶  decision graph ─┐ ├─ MCP server (inline)
  Linear, Notion        │    (read-only) (what/why/who)  ├─┤  edit hooks (any agent)
  Slack, Teams, Zoom   ─┘                  + relationships┘ └─ align check (CI)
```

1. **Import** pulls decisions out of the tools you already use. Read-only, nothing is modified.
2. Align links them into a **decision graph**: what was decided, why, who decided it, and how
   decisions relate (supersedes, conflicts with, depends on).
3. Your agents **query and check against** it, over MCP, an edit hook, CI, or `align ask`.

## Your agent checks before it writes

`align setup` wires Align in four ways, so context fires whether or not the model thinks to ask.

| | What you get |
|---|---|
| **MCP server** | Claude Code, Cursor, Claude Desktop and Windsurf query the graph inline |
| **Edit hooks** | Prior decisions reach the model before it writes. Claude Code, pi, Gemini CLI, OpenCode |
| **Editor rules** | A managed block in `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/align.md` |
| **Shared `.mcp.json`** | One committed file wires up the whole team |

The hook is **non-blocking and fail-open**. It never denies an edit by default, and if Align is
missing, slow or unreachable the edit proceeds untouched. It needs no AI provider key.

Cursor and Codex CLI can't do the pre-edit hook, and that's a limit of those hosts. They get the
other three. Full per-host matrix: [docs/agent-hooks.md](docs/agent-hooks.md).

> The first time Claude Code loads a project with a committed hook, it shows a one-time "approve
> hooks" prompt. Accept it to enable automatic alignment.

## Everyday commands

```bash
align ask "how does our auth work"   # natural language answer with sources
align search "authentication"        # ranked list, no AI needed
align ask src/auth/session.ts        # a file path finds decisions about that file
align import git                     # pull commit history, no token
align import jira --token ...        # add more sources
align capture <url>                  # capture one decision from a PR, ticket or thread
align check                          # check your staged diff against the graph
align context sync                   # write decisions to .align/decisions.md
```

`align ask` needs an AI provider to write prose. Without one it returns the matching decisions
as a ranked list, which needs no key. Bring your own: Anthropic, OpenAI, Gemini, Groq, Mistral,
Grok, any OpenAI-compatible endpoint, or a local Ollama.
[Setting one up](docs/configuration.md#ai-provider).

## Docs

| | |
|---|---|
| [Importing](docs/importing.md) | Every source, tokens, flags |
| [Alignment check](docs/check.md) | Modes, exit codes, CI, the GitHub Action |
| [Cloud or local-only](docs/local-mode.md) | What runs where, what touches the network |
| [MCP server](docs/mcp.md) | Editor config, the tools your assistant gets |
| [Configuration](docs/configuration.md) | AI providers, env vars, auth, self-hosting |
| [Agent hooks](docs/agent-hooks.md) | Per-host capability matrix |
| [All commands](docs/commands.md) | Full reference |

## Why bother

In a published benchmark, giving a coding agent recorded product decisions took decision
compliance from 46% to 95%
([Dillon & Varanasi, arXiv:2605.08112](https://arxiv.org/abs/2605.08112) - a small vendor study,
8 tasks and 41 decision points, and it isn't our data).

Wiring context into an agent is the easy part, and this repo is the open-source version of it.
The hard part is the record underneath: what your team actually decided, across every tool, kept
current.

Want a hand setting it up? I do free 30 minute setup calls:
https://calendly.com/tom-align/setup

## License

MIT, see [LICENSE](./LICENSE). The CLI and MCP server are open source, along with the
[connector SDK](https://github.com/aligndottech/align-connector-sdk). The hosted gateway is a
separate commercial service.
