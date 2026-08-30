# Configuration

## AI provider

Align is **provider-agnostic**. `align ask` and local relationship typing use **your own AI
provider**. No key is ever required: without one, `align ask` prints a ranked list of matching
decisions instead of a synthesised paragraph.

It resolves a provider in this order.

### 1. Any OpenAI-compatible endpoint

`ALIGN_LLM_BASE_URL` covers OpenRouter, Together, DeepSeek, LM Studio, vLLM, or any self-hosted
OpenAI-compatible server. This outranks the named keys below, so it wins even when
`ANTHROPIC_API_KEY` is also set.

```bash
export ALIGN_LLM_BASE_URL=https://api.deepseek.com
export ALIGN_LLM_API_KEY=sk-...
export ALIGN_LLM_MODEL=deepseek-chat
```

### 2. A named provider via env key

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `GROQ_API_KEY`,
`MISTRAL_API_KEY`, or `GROK_API_KEY` (or `XAI_API_KEY`).

Each has an optional model override: `ALIGN_ANTHROPIC_MODEL`, `ALIGN_OPENAI_MODEL`,
`ALIGN_GEMINI_MODEL`, `ALIGN_GROQ_MODEL`, `ALIGN_MISTRAL_MODEL`, `ALIGN_GROK_MODEL`.

### 3. Ollama

[Ollama](https://ollama.com) running locally, auto-detected on `localhost:11434`, override with
`OLLAMA_HOST`. It needs a general-purpose model from a recognised family installed: `llama`,
`mistral`, `gemma`, `phi`, `qwen` or `deepseek-r`. The installed version is read from Ollama
itself, so a new release of any of those works the day it ships. Families are tried in the order
above, and within the first one you have installed, the newest wins.

Ollama won't answer from a model outside those families, or from one tuned for a different job
(any tag containing `coder`, `code`, `math`, `embed`, `guard`, `vision`, `uncensored` or
`dolphin`). Such a model will still write fluent prose about your decisions, including
relationships between them that do not exist, and it isn't obvious from the output that anything
went wrong.

To use any model regardless, name it and it's used as-is:

```bash
export ALIGN_OLLAMA_MODEL=my-fine-tune:latest
```

> **A Claude.ai or ChatGPT subscription is not an API key.** You need a separate API account.
> [Groq](https://console.groq.com/keys) has a free tier with no credit card.

In cloud mode, retrieval runs on Align's gateway and the provider key is only used locally to
phrase the answer. In local-only mode, retrieval is on-device too.

## Environments

The CLI targets `prod` (`api.align.tech`) by default. Set a sticky default, or override per
command. `--env` belongs after the command name.

```bash
align env set preview             # stick to preview for this machine
align env get                     # show current default
align search "auth" --env local   # one-off override on any command
```

> **One naming trap.** `--env local` means your embedded SQLite graph only after
> `align setup --local` has configured it. On a machine that never ran that, `local` is a
> developer convenience that addresses a gateway on `localhost:8080`.

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
| `ALIGN_LLM_TIMEOUT_MS` | How long to wait for a model. Defaults to 15s for a hosted API and 5 minutes for one on your own machine or network, because a large quantised model on CPU takes minutes and there is no cost pressure to give up early on hardware you own. Set it if even that is not enough |
| `OLLAMA_HOST` | Ollama host (default `http://localhost:11434`). Your own machine by default; point it at a shared box and local relationship typing goes there instead |
| `ALIGN_OLLAMA_MODEL` | Use this Ollama model, whatever family it's from |
| `ALIGN_INGEST_CONCURRENCY` | Concurrent ingest batch requests during imports (default `6`) |
| `PI_CODING_AGENT_DIR` | Where `align mcp --setup` writes pi's `mcp.json`, if pi keeps its config somewhere non-standard |

## Authentication

```bash
align login                   # opens your browser; the token arrives via a localhost callback
align login --token algt_...  # non-interactive, good for CI and self-hosted
align whoami                  # verify current session
align logout                  # clear stored credentials
```

`align login` starts a small localhost listener, opens the Align sign-in page, and receives the
token on the callback. Nothing to paste. It prints the sign-in URL too, in case the browser
doesn't open. If the callback can't complete (a locked-down machine, no free port), use
`align login --token` instead.

Tokens are stored locally in your OS config directory. To create one manually, go to
**Settings > API Tokens** in the Align web app.

> **Seeing `401 unauthorized`?** Every command defaults to the hosted gateway, so it needs
> `align login` first. If you meant the no-account path, run `align setup --local` (or
> `align local start`) and the same commands will use your local graph instead.

## Self-hosted

```bash
align login --env local --token algt_...
# or
ALIGN_GATEWAY_URL=https://api.yourco.com align decisions list
```

`ALIGN_GATEWAY_URL` changes **where** the CLI talks to. `--env` changes **how** it
authenticates. The two are independent, which matters if you also set `ALIGN_TENANT_ID`, because
a tenant with nothing authenticating it is refused in `prod` and `preview`.

| Your gateway | Use | Why |
|---|---|---|
| enforces auth (the default) | `ALIGN_TOKEN` alongside `ALIGN_GATEWAY_URL` | the token names your tenant, so `ALIGN_TENANT_ID` is optional |
| runs in demo mode | `--env local` with `ALIGN_GATEWAY_URL` | `local` is the mode where an `x-tenant-id` header with no bearer is the intended way to address a gateway |

With no `--env` the CLI defaults to `prod`, which authenticates. So `ALIGN_TENANT_ID` set on its
own, with no token, is refused rather than sent. It can't succeed against a gated route, and
against an ungated one it would read a tenant you were never authorised for.
