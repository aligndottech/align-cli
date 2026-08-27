# Align CLI

[![npm version](https://img.shields.io/npm/v/@aligndottech/cli.svg)](https://www.npmjs.com/package/@aligndottech/cli)
[![CI](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aligndottech/align-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/@aligndottech/cli.svg)](https://nodejs.org)

**Your AI agents know the code. They don't know the company.**

The decisions behind the code live in commits, tickets, chat and meetings - and months later
nobody can tell what still stands, what conflicts, or why. [Align](https://align.tech) pulls
those decisions into one graph your agents and your team check before they build.

This CLI is the free, open-source way in. It builds a decision graph from the tools you
already use - git history, GitHub, GitLab, Jira, Confluence, Linear, Slack, Teams, Zoom,
Notion - and serves it to any MCP agent, with an edit hook that surfaces prior decisions
before the agent writes. No account required. Beta, pre-1.0.

In a published benchmark, giving a coding agent recorded product decisions took decision
compliance from 46% to 95% ([Dillon & Varanasi, arXiv:2605.08112](https://arxiv.org/abs/2605.08112) -
a small vendor study, 8 tasks and 41 decision points, and it isn't our data).

```
npm install -g @aligndottech/cli
```

Node 20+ required. MIT licensed.

> **Install notes.** Cloud mode needs no native build. Local-only mode additionally
> uses an on-device embedding model (`@huggingface/transformers`, an optional dependency)
> that ships native binaries for macOS, glibc Linux, and Windows (x64/arm64) - on
> those platforms `npm i -g` just works. On Alpine/musl, uncommon architectures, or
> behind a strict proxy the optional model may not install; the global install still
> succeeds and cloud mode works, and local-only mode will tell you the model is unavailable
> rather than failing silently. The first import downloads the model from
> huggingface.co (~23MB) once, and nothing local can be embedded or searched until that
> succeeds - so on a restricted network, check that host is reachable before you begin.

## Quick start

```bash
align setup
```

One guided command: login (or local-only mode), connect your tools via read-only OAuth, seed the graph from your git history, configure your editors' MCP, and wire up automatic alignment checks for AI agents.

Or step by step:

```bash
align login                              # authenticate
align setup                              # connect tools (read-only OAuth) + configure MCP
align import git                         # pull commit history - no token needed
align ask "how does our auth work"       # natural language answer from your graph
```

Want a hand setting this up? I do free 30 minute setup calls: https://calendly.com/tom-align/setup

## How it works

```
  Your tools                      Align                       Your agents & you
  ──────────                   ───────────                  ───────────────────
  Git, GitHub, GitLab  ─┐                                  ┌─ align ask "why…"
  Jira, Confluence      ├─▶  import  ─▶  decision graph ─┐ ├─ MCP server (inline)
  Linear, Notion        │    (read-only) (what/why/who)  ├─┤  edit hooks (any agent)
  Slack, Teams, Zoom   ─┘                  + relationships┘ └─ align check (CI)
```

1. **Import** pulls the decisions out of the tools you already use - read-only, nothing is modified.
2. Align links them into a **cross-tool decision graph**: what was decided, why, who decided it, and how decisions relate (supersedes, conflicts with, depends on).
3. Your agents and you **query and check against** that graph - over MCP, an edit hook in your agent, CI, or plain `align ask`.

Wiring context into an agent is the easy part, and this repo is the open-source version of it.
The hard part is the record underneath: what your team actually decided, across every tool,
kept current. The CLI and MCP server are open source (this repo,
plus the [connector SDK](https://github.com/aligndottech/align-connector-sdk)). The hosted
graph and the heavier cross-tool relationship detection are a separate commercial gateway; you
can also run fully local with `--local`.

## Auto-alignment for AI agents

When you run `align setup`, Align makes itself available to your AI agents four ways, so the context fires whether or not the model thinks to ask for it:

1. **MCP server** - your assistant (Claude Code, Cursor, Claude Desktop, Windsurf) can query the decision graph inline. The server ships with instructions telling the agent to check alignment *before* making non-trivial changes.
2. **Edit hooks** - setup registers `align check --advisory` with every host that exposes a hook API, so prior decisions related to the change reach the model whether or not it thought to ask. **Claude Code** (`.claude/settings.json`), **pi** (`.pi/extensions/align.ts`), **Gemini CLI** (`.gemini/settings.json`) and **OpenCode** (`.opencode/plugins/align.js`) all check the *proposed* change before it is written. It is **non-blocking and fail-open**: it never denies an edit by default, and if Align is missing, slow or unreachable the edit proceeds untouched. As `align setup` writes it, the hook is retrieval only, so it needs no AI provider key and makes no provider call. (Adding `--block-on-critical` yourself changes both halves of that - see the table below.)

   **Cursor and Codex CLI cannot do this**, and that is a limit of those hosts, not a gap in setup: Cursor has no `beforeFileEdit` and its `afterFileEdit` hook has no output fields, and Codex's `PreToolUse` intercepts Bash only. They get layers 1, 3 and 4. The full per-host matrix, and why, is in [docs/agent-hooks.md](docs/agent-hooks.md).
3. **Editor rules** - a managed, marker-delimited block in your `CLAUDE.md` and `AGENTS.md`, plus a `.cursor/rules/align.md` file (Cursor doesn't honor Claude Code hooks), nudge agents to consult the graph.
4. **A shared `.mcp.json`** at the repo root - the tool-agnostic MCP config that pi, Claude Code and others read, so one committed file wires up the whole team rather than each person's per-host config.

The hook, rule and `.mcp.json` files are committed to the repo, so the whole team's agents get the same guardrail. Re-running `align setup` updates them in place (idempotent - no duplicate hooks or blocks).

> **Heads up:** the first time Claude Code loads a project with a committed hook, it shows a one-time "approve hooks" prompt. Accept it to enable automatic alignment.

You can also run the advisory check yourself. It always exits 0, and when it finds related prior decisions (or could not check at all) prints the hook output in whichever host's shape you ask for - `--format text` is plain prose for a host with no JSON contract. It reports the decisions as related, not as conflicts: retrieval finds decisions on the same subject and does not adjudicate opposition. A decision the hook surfaced moments ago in the same directory is not repeated, so the pre and post hooks don't say everything twice.

```bash
align check --advisory                  # Claude Code shape (default)
align check --advisory --format text    # plain text, for any other agent
```

## Asking questions

`align ask` retrieves the most relevant decisions from your graph and synthesises a concise natural language answer:

```bash
align ask "why do we use postgres"
align ask "how does the auth module work"
align ask "what was decided about caching"
align ask "do we use redis"
```

Ask in plain English. In cloud mode the gateway picks keyword or semantic search based on your phrasing; in local-only mode every query is semantic. Either way, full questions ("why do we use postgres") work as well as short terms ("postgres"). Pass a file path instead of a question to find decisions related to that file:

```bash
align ask src/auth/session.ts
```

### AI provider for conversational answers

Align is **provider-agnostic** - `align ask` (and local relationship typing) uses **your own AI provider**. It resolves one, in order:

1. **Any OpenAI-compatible endpoint** via `ALIGN_LLM_BASE_URL` (+ `ALIGN_LLM_API_KEY`, `ALIGN_LLM_MODEL`) - covers OpenRouter, Together, DeepSeek, LM Studio, vLLM, or any self-hosted OpenAI-compatible server. This outranks the named keys below, so it wins even when `ANTHROPIC_API_KEY` is also set. Example:
   ```bash
   export ALIGN_LLM_BASE_URL=https://api.deepseek.com
   export ALIGN_LLM_API_KEY=sk-...
   export ALIGN_LLM_MODEL=deepseek-chat
   ```
2. A named provider via env key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `GROQ_API_KEY`, `MISTRAL_API_KEY`, or `GROK_API_KEY` (or `XAI_API_KEY`). Each has an optional model override (`ALIGN_ANTHROPIC_MODEL`, `ALIGN_OPENAI_MODEL`, `ALIGN_GEMINI_MODEL`, `ALIGN_GROQ_MODEL`, `ALIGN_MISTRAL_MODEL`, `ALIGN_GROK_MODEL`).
3. [Ollama](https://ollama.com) running locally (auto-detected on `localhost:11434`, override `OLLAMA_HOST`), with a general-purpose model from a recognised family installed: `llama`, `mistral`, `gemma`, `phi`, `qwen` or `deepseek-r`. The installed version is read from Ollama itself, so a new release of any of those works the day it ships; families are tried in the order above, and within the first one you have installed, the newest wins.

   Ollama will not answer from a model outside those families, or from one tuned for a different job (any tag containing `coder`, `code`, `math`, `embed`, `guard`, `vision`, `uncensored` or `dolphin`). Such a model will still write fluent prose about your decisions, including relationships between them that do not exist, and it is not obvious from the output that anything went wrong. To use any model regardless, name it and it is used as-is:

   ```bash
   export ALIGN_OLLAMA_MODEL=my-fine-tune:latest
   ```

If none is available, `align ask` still works - it prints a ranked list of the matching decisions instead of a synthesised paragraph. No key is ever required.

**Note:** A Claude.ai or ChatGPT subscription is not the same as an API key - you need a separate API account. [Groq](https://console.groq.com/keys) offers a free tier with no credit card.

In cloud mode, retrieval (the search over your graph) runs on Align's gateway and the provider key is only used locally to phrase the answer. In local-only mode, retrieval is on-device too.

## Authentication

```bash
align login                  # opens your browser; the token arrives via a localhost callback
align login --token algt_...  # non-interactive, good for CI / self-hosted
align whoami                 # verify current session
align logout                 # clear stored credentials
```

`align login` starts a small localhost listener, opens the Align sign-in page, and receives the token on the callback - nothing to paste. It prints the sign-in URL too, in case the browser does not open; if the callback cannot complete (a locked-down machine, no free port), use `align login --token` instead. Tokens are stored locally in your OS config directory. To create one manually, go to **Settings > API Tokens** in the Align web app.

## Cloud or local-only

`align setup` offers two modes:

- **Personal cloud** (default) - your decision graph is hosted at Align: synced across machines, backed up, and upgradeable to a shared team workspace. Connectors connect via **read-only browser OAuth** (no tokens to paste), and `align ask` retrieval runs server-side. Nothing you connect can be modified by the CLI - it only reads.
- **Local-only** (`align setup --local`) - **no account, and no Align servers**: the graph, embeddings, and search all live in a SQLite database on your machine, and the CLI never sends your decisions to us.

What uses the network in local-only mode, all worth knowing before you point it at work content:

- The embedding model downloads once from huggingface.co (~23MB), on the first import.
- `align import <tool>` calls that tool's API, read-only, with the token you pasted - that is what an import is. The data goes from your tool to your machine; none of it goes to Align.
- **Only when an AI provider is available** - an API key in your environment, or a running Ollama, which needs no key - three surfaces call **your own provider**: `align ask` sends your question plus the titles and summaries of the decisions it retrieved (up to `--limit`, default 8), and `align check` and the MCP tool `align_check_alignment` send up to 2,000 characters of the proposed change paired with one retrieved decision at a time. The editor hook never does by default - it is retrieval only, provider or no provider. The one exception is explicit: adding `--block-on-critical` to your hook line opts that hook into background adjudication on the same terms as `align check`, roughly once per edit where retrieval found something.
- Ollama runs on your own machine by default, so those calls stay local - unless you have pointed `OLLAMA_HOST` at another box, in which case they go there.
- With no provider available at all, nothing goes to any AI provider - retrieval is on-device, so the editor hook still surfaces related decisions - and nothing ever goes to Align. The network surface is then just the one-time model download and whatever imports you run.

How the local graph behaves:

- Seeds from your git history out of the box; other sources connect by pasting a **read-only personal token** (OAuth needs the hosted callback, so it isn't available offline). Add `--env local` to any `align import <tool>` run.
- **Re-importing is safe**: a decision is identified by its source URL and title, so running the same import twice updates what changed rather than duplicating the graph.
- Related decisions are surfaced on-device by semantic similarity; typed relationships (supersedes / conflicts with / depends on) are typed at query time using **your own AI provider key** (Anthropic, OpenAI, or a local Ollama) - without one, related decisions still surface, just not typed. The heavier cross-tool relationship detection runs in the hosted gateway.
- Run `align local status` to inspect the graph, `align local reset` to wipe it.
- Works in local-only mode today: `setup`, `import <tool>`, `capture`, `ask`, `search`, `check`, `status`, `context sync`, `mcp`, and the `local` commands. Not yet routed to the local graph (they address the cloud gateway): `decisions`, `export`, `drift`, `links`, `spaces`, `check --resolve`, and the connector-scan commands under `align import`.

Pick cloud for sync + team upgrade, local for maximum privacy. You can always start local and move to cloud later.

## Importing decisions

Pull your existing work into the decision graph. The more sources you add, the richer the cross-tool relationship detection.

**Easiest way: `align setup`.** It connects each source via a **read-only browser OAuth** consent - no tokens to create or paste. The CLI only ever *reads*; it can't modify your tools (write access lives only in the team/org bot apps). GitHub, Jira, Confluence, Slack, Microsoft Teams, Zoom, Linear, GitLab (gitlab.com), and Notion all use OAuth. Self-managed GitLab (a custom domain) uses a read-only token you paste.

The same OAuth flow also works per source: `align import <source> --personal` opens the browser consent (or reuses the token a previous `align setup` cached) - no PAT to create. The `align import <source> --token ...` forms below are the manual / CI alternative (and how to connect self-managed hosts). Every import previews what will be imported and asks for confirmation before sending anything (use `--approve` to skip the prompt). In local-only mode, add `--env local` - a machine that has also logged in to cloud otherwise imports to the cloud graph.

### Git

```bash
align import git
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `500` | Max commits to import |
| `--branch` | current branch | Git branch to scan |
| `--from` | - | Start date (ISO, e.g. `2025-01-01`) |
| `--to` | - | End date (ISO) |
| `--approve` | - | Skip confirmation prompt |

### GitHub / GitLab

Prefer `align setup` - GitHub and gitlab.com connect via read-only OAuth (no token to create). Manual / self-managed alternative:

```bash
align import github --token ghp_...      # or connect via `align setup` (read-only OAuth)
align import gitlab --token glpat-...     # self-managed GitLab: create a read_api (read-only) token
```

### Jira

```bash
align import jira \
  --token <your-jira-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

### Linear

Prefer `align setup` - Linear connects via read-only OAuth (scope `read`). Manual alternative:

```bash
align import linear --token lin_api_...
```

### Confluence

```bash
align import confluence \
  --token <your-confluence-api-token> \
  --email your@email.com \
  --domain yourorg.atlassian.net
```

### Slack (experimental)

Prefer `align setup` - Slack connects via read-only OAuth (read scopes only, no `chat:write`). Note: the Slack app must have public distribution enabled, or you authorize from its home workspace.

> **Manual alternative:** `align import slack` requires a Slack **user** token (`xoxp-...`), not a bot token.
>
> To get one: go to [api.slack.com/apps](https://api.slack.com/apps), create an app, add these User Token Scopes under OAuth & Permissions: `channels:read`, `channels:history`, `groups:read`, `groups:history`. Install to your workspace and copy the OAuth User Token.

```bash
align import slack --token xoxp-<your-slack-user-token>
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `50` | Max threads to import |
| `--days-back` | `90` | How many days back to scan |

### Notion

Create an internal integration with **only "Read content"** capability (no insert/update), then paste its secret:

```bash
align import notion --token <your-notion-integration-token>
```

### Microsoft Teams / Zoom

Prefer `align setup` (OAuth) - neither has a personal token a human can create in-app, so they are not offered in local-only setup. `align import teams --token <Graph token>` and `align import zoom --token <OAuth token>` exist for tokens you obtained elsewhere.

### Connector scans (cloud)

With a cloud account, the gateway can also run connector-side scans and hold the results as suggestions for review:

```bash
align import --all           # start a scan across every enabled connector
align import list            # scan jobs and their status
align import suggestions     # review what a scan found
align import scan-runs       # scan history
```

## Capturing decisions

```bash
# Capture a decision from a URL - the platform is detected automatically
align capture https://github.com/org/repo/pull/42
align capture https://yourco.atlassian.net/browse/ENG-123
align capture https://yourco.slack.com/archives/C123/p1700000000000000
```

`align capture` takes a URL; raw text capture is not supported from the CLI yet. Over MCP, `align_capture` accepts text too, in local-only mode.

## Searching and browsing

```bash
align ask "any question in plain English"  # natural language answer
align search "authentication strategy"      # keyword/semantic search - returns a list
align decisions list                        # browse the graph (cloud)
align decisions list --space backend        # filter by space
align decisions list --platform jira        # filter by source platform
align decisions show <id>                   # full detail for one decision (cloud)
align links list                            # cross-tool decision relationships (cloud)
align drift                                 # decisions that may be out of date (cloud)
align export                                # export decisions as a structured brief (cloud)
```

`align ask` synthesises an answer. `align search` returns a ranked list - useful when you want to browse. The commands marked cloud address your hosted graph; in local-only mode use `align search`, `align ask` and `align local status` instead.

## Alignment check

Check your current changes against the decision graph.

```bash
align check          # check the staged diff (falls back to the HEAD diff when nothing is staged)
align check --all    # check the full working-tree diff vs HEAD
```

Four outcomes: aligned or nothing-related exits `0`; a conflict exits `1`; and `2` means the
check retrieved decisions it could not adjudicate, or could not run at all - not a pass, and
distinguishable from a conflict on purpose. That clean 0/1/2 contract is guaranteed under
`--ci`; in default interactive mode a transport error or a missing git repository also exits
`1`.

Modes:

| Mode | Behavior |
|------|----------|
| (default) | Human-readable output; exits `1` on any conflict. |
| `--hook` | Pre-commit mode: silent when there's no context, only fails on **critical** conflicts. |
| `--advisory` | Agent hook mode (detects pre vs post from the hook payload on stdin): **always exits 0**, emits related, unadjudicated decisions - or an explicit "could not check" notice - in the host's hook shape (`--format claude\|gemini\|pi\|opencode\|text`). Fail-open. |
| `--advisory --block-on-critical` | Opt-in deferred adjudication: when retrieval finds related decisions, the hook additionally spawns a background full check, and a **retry of a change already judged a critical conflict is denied** (Claude Code `permissionDecision: "deny"`), with the verdict expiring after 15 minutes. The verdict is keyed on the tool, the target file and the text together, so a different file or an adjusted approach proceeds untouched - it catches a re-presentation, never a first proposal. Runs per edit, up to 3 at a time per project. In local mode it calls **your own AI provider**, which the default hook never does. |
| `--ci` | Emits JSON to stdout; the 0/1/2 exit contract above. **Pass `--base`** or there is nothing to diff. |

Useful flags: `--title "what this change decides"` improves adjudication on a bare diff;
`--base <ref>` diffs `base...HEAD` instead of the staged diff.

In CI, always pass `--base` - a clean checkout has no staged diff, and a check with nothing to
diff would pass without looking:

```yaml
- name: Check alignment
  run: align check --base origin/${{ github.base_ref }} --ci
  env:
    ALIGN_TOKEN: ${{ secrets.ALIGN_TOKEN }}
```

Or use the published GitHub Action, which always passes `--base`, writes the verdict to the
job summary and annotates the changed files:
[`aligndottech/decision-check`](https://github.com/aligndottech/decision-check).

When a check flags a conflict, resolve it so it stops surfacing (only meaningful while the
current diff is conflicting):

```bash
align check --resolve <decision_id>:honored      # or overridden | context_changed
```

## Write decisions into your agent's context files

Agents read local files before they reach for any tool. `align context sync` writes your
active decisions to `.align/decisions.md` and adds one import line to CLAUDE.md, so an
agent knows what your team decided without a single tool call. Superseded and archived
decisions are history, and stay out of it.

```bash
align context sync           # write .align/decisions.md, import it from CLAUDE.md
```

Align owns `.align/decisions.md` outright and regenerates it on each sync - your CLAUDE.md
is never rewritten, only ever appended with the single `@.align/decisions.md` line, once.
If the repo has no CLAUDE.md, the command prints the line to add instead of inventing a
file. Re-run after new decisions land; unchanged decisions produce a byte-identical file,
so syncing never dirties a clean tree.

## MCP server

Run Align as a local [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants (Claude Code, Claude Desktop, Cursor, Windsurf) can query your decision graph inline.

```bash
align mcp --setup   # auto-configure detected editors
align mcp           # start the server directly
```

### Manual configuration

**Claude Desktop** - `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "align": {
      "command": "align",
      "args": ["mcp"],
      "env": { "ALIGN_TOKEN": "algt_..." }
    }
  }
}
```

**Claude Code** - `~/.claude.json` or your workspace `.mcp.json`:

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"] }
  }
}
```

**Cursor** - `~/.cursor/mcp.json` (same format as Claude Code above).

**pi** - MCP is not built in; install the adapter first with `pi install npm:pi-mcp-adapter`, then restart pi. `align setup` writes `~/.pi/agent/mcp.json` (or `$PI_CODING_AGENT_DIR/mcp.json`):

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"], "directTools": true }
  }
}
```

`directTools` matters: the adapter is lazy by default and hides every server behind a single proxy tool the agent has to search first, which defeats the "check alignment *before* the edit" instruction.

Once configured, your assistant can call these tools to query and update your decision graph in context:

| Tool | Purpose |
|------|---------|
| `align_ask` | Natural-language question about past decisions |
| `align_search` | Search the decision graph |
| `align_capture` | Capture a decision from a URL (raw text too, in local-only mode) |
| `align_check_alignment` | Check a proposed change for conflicts with prior decisions |
| `align_check_drift` | Check whether code/config has drifted from a decision |
| `align_get_related_decisions` | Decisions related to a file or module |
| `align_get_conflicts` | Active conflicts in the graph |
| `align_get_impact` | Upstream/downstream impact of a decision |

## Environments

By default the CLI targets `prod` (`api.align.tech`). Use a sticky default, or override per command - `--env` belongs after the command name:

```bash
align env set preview          # stick to preview for this machine
align env get                  # show current default
align search "auth" --env local   # one-off override on any command
```

One naming trap: `--env local` means your embedded SQLite graph only after `align setup --local`
has configured it. On a machine that never ran that, `local` is a developer convenience that
addresses a gateway on `localhost:8080`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALIGN_TOKEN` | API token (alternative to `align login`) |
| `ALIGN_ENV` | Default environment (`prod`, `preview`, `local`) |
| `ALIGN_GATEWAY_URL` | Override gateway URL (self-hosted) |
| `ALIGN_TENANT_ID` | Override tenant ID (self-hosted / CI). Against `preview` or `prod` it needs `ALIGN_TOKEN` set too: a tenant on its own authenticates nothing, and the CLI refuses rather than sending it |
| `ALIGN_TELEMETRY` | Set it to anything other than `1`/`true`/`yes`/`on` to send no usage events at all (empty counts as unset, so leaves them on). Cloud mode reports one `cli.command` event per invocation to the same gateway - the command name, nothing else. Local mode sends nothing either way |
| `ALIGN_DEBUG` | Set to any value to print the full stack trace when the CLI crashes with an unexpected error |
| `ANTHROPIC_API_KEY` | Anthropic API key for `align ask` synthesis |
| `OPENAI_API_KEY` | OpenAI API key for `align ask` synthesis |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Gemini API key for `align ask` synthesis |
| `GROQ_API_KEY` | Groq API key for `align ask` synthesis |
| `MISTRAL_API_KEY` | Mistral API key for `align ask` synthesis |
| `GROK_API_KEY` / `XAI_API_KEY` | xAI Grok API key for `align ask` synthesis |
| `ALIGN_LLM_BASE_URL` | Any OpenAI-compatible endpoint. Outranks the named keys above |
| `ALIGN_LLM_API_KEY` | Bearer token for `ALIGN_LLM_BASE_URL` |
| `ALIGN_LLM_MODEL` | Model name for `ALIGN_LLM_BASE_URL` (default `gpt-4o-mini`) |
| `OLLAMA_HOST` | Ollama host (default: `http://localhost:11434`). Your own machine by default; point it at a shared box and local relationship typing goes there instead |
| `ALIGN_OLLAMA_MODEL` | Use this Ollama model, whatever family it is from |
| `ALIGN_INGEST_CONCURRENCY` | Concurrent ingest batch requests during imports (default `6`) |
| `PI_CODING_AGENT_DIR` | Where `align mcp --setup` writes pi's `mcp.json`, if pi keeps its config somewhere non-standard |

Advanced: override the model per provider with `ALIGN_ANTHROPIC_MODEL`, `ALIGN_OPENAI_MODEL`, `ALIGN_GEMINI_MODEL`, `ALIGN_GROQ_MODEL`, `ALIGN_MISTRAL_MODEL`, `ALIGN_GROK_MODEL`, or `ALIGN_OLLAMA_MODEL`.

## Self-hosted

```bash
align login --env local --token algt_...
# or
ALIGN_GATEWAY_URL=https://api.yourco.com align decisions list
```

`ALIGN_GATEWAY_URL` changes **where** the CLI talks to; `--env` changes **how** it authenticates, and the two are independent. That matters if you also set `ALIGN_TENANT_ID`, because a tenant with nothing authenticating it is refused in `prod`/`preview` (auth mode):

| Your gateway | Use | Why |
|---|---|---|
| enforces auth (the default) | `ALIGN_TOKEN` alongside `ALIGN_GATEWAY_URL` | the token is what names your tenant, so `ALIGN_TENANT_ID` is optional |
| runs in demo mode | `--env local` with `ALIGN_GATEWAY_URL` | `local` is the mode where an `x-tenant-id` header with no bearer is the intended way to address a gateway |

With no `--env` the CLI defaults to `prod`, which authenticates. So `ALIGN_TENANT_ID` set on its own, with no token, is refused rather than sent: it cannot succeed against a gated route, and against an ungated one it would read a tenant you were never authorised for.

## Command reference

```
align setup                  Guided onboarding: connect tools, configure MCP + auto-alignment
align login                  Authenticate with Align
align logout                 Remove stored credentials
align whoami                 Show current authenticated user and tenant
align ask <query>            Ask a natural language question (or pass a file path)
align search <query>         Keyword/semantic search - returns a ranked list
align capture <url>          Capture a decision from a URL (platform auto-detected)
align check                  Check current changes against the decision graph
align import git             Import from Git commit history (no auth)
align import github          Import from GitHub
align import gitlab          Import from GitLab
align import jira            Import from Jira
align import linear          Import from Linear
align import confluence      Import from Confluence
align import slack           Import from Slack (experimental)
align import teams           Import from Microsoft Teams
align import zoom            Import from Zoom recording transcripts
align import notion          Import from Notion
align import --all           Start a connector scan across enabled connectors (cloud)
align import list            List scan jobs (cloud)
align import suggestions     Review scan suggestions (cloud)
align import scan-runs       Scan history (cloud)
align decisions list         List decisions in your graph (cloud)
align decisions show <id>    Show full detail for a decision (cloud)
align status                 Value readout: what your graph has done for you
align context sync           Write decisions to .align/decisions.md + CLAUDE.md import
align export                 Export decisions as a structured brief (cloud)
align drift                  Show decisions that may be out of date (cloud)
align links list             Show cross-tool decision relationships (cloud)
align spaces list            List spaces (project scopes) (cloud)
align env set <name>         Set default environment
align env get                Show current environment
align mcp                    Start local MCP server
align mcp --setup            Auto-configure editors to use Align as MCP server
align local start            Initialize a local decision graph
align local status           Show local graph statistics
align local reset            Wipe the local graph
```

## License

MIT - see [LICENSE](./LICENSE). The CLI and MCP server are open source; the hosted gateway is a separate commercial service.
