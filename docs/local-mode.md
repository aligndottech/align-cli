# Cloud or local-only

`align setup` offers two modes.

- **Cloud** (default). Your graph is hosted at Align: synced across machines, backed up, and
  cross-tool relationship detection runs server-side. Connectors connect via **read-only
  browser OAuth**, and `align ask` retrieval runs server-side. Which tenant you land in is
  decided entirely by the email you sign in with - there's no separate personal-vs-team
  picker:
  - **Work email** - you join the tenant already registered for that domain, or a new one is
    created and you're its admin if you're first. The next colleague who signs in with the same
    domain lands in that same tenant automatically. No invite needed.
  - **Personal email** (gmail, outlook, icloud, ...) - you get a tenant of one. Moving into a
    company tenant later is a web-only invite flow, and everything you brought over stays
    private (`creator_only`) until you or an admin change that. There is no automatic merge of
    a personal graph into a team's.
- **Local-only** (`align setup --local`). **No account, and no Align servers.** The graph,
  embeddings and search all live in a SQLite database on your machine, and the CLI never sends
  your decisions, your code, or any file content to us. It sends two anonymous counts by
  default (install, setup completed); usage only with your consent; `align telemetry off` or
  `DO_NOT_TRACK=1` stops all of it. See Telemetry below, and [every field](telemetry.md).

Pick cloud on a work email to land straight in your company's graph, local for maximum
privacy. You can start local and move to cloud later.

## What touches the network in local-only mode

Worth knowing before you point it at work content.

- The embedding model downloads once from huggingface.co (~23MB), on the first import.
- `align import <tool>` calls that tool's API, read-only, with the token you pasted. That's what
  an import is. The data goes from your tool to your machine. None of it goes to Align.
- **Only when an AI provider is available** (an API key in your environment, or a running
  Ollama, which needs no key) three surfaces call **your own provider**:
  - `align ask` sends your question plus the titles and summaries of the decisions it retrieved,
    up to `--limit`, default 8.
  - `align check` and the MCP tool `align_check_alignment` send up to 2,000 characters of the
    proposed change, paired with one retrieved decision at a time.
  - The editor hook never does by default. It's retrieval only, provider or no provider. Adding
    `--block-on-critical` to your hook line opts that hook into background adjudication on the
    same terms as `align check`, roughly once per edit where retrieval found something.
- Ollama runs on your own machine by default, so those calls stay local, unless you've pointed
  `OLLAMA_HOST` at another box.
- With no provider available at all, nothing goes to any AI provider. Retrieval is on-device, so
  the editor hook still surfaces related decisions, and nothing ever goes to Align. The network
  surface is then the one-time model download and whatever imports you run.

## Telemetry

Two different models, by design, and `align telemetry status` always tells you which one
applies to the environment you're running in and why. [Every event and every field](telemetry.md)
is listed on its own page, and a test keeps that page true.

- **Cloud mode is opt-out.** You're already on an authenticated connection to Align's gateway,
  so a usage event about a call you're already making isn't a new phone-home. Set
  `ALIGN_TELEMETRY=0` to turn it off.
- **Local-only mode sends two anonymous counts by default, and usage only with your consent.**
  The two counts: one the first time you run `align` (install: a random id generated once for
  this machine, the CLI version, and the OS name), one when the setup wizard finishes (setup
  completed). That's the whole default. They exist so we can tell how many people install and
  how many of them say yes to the next part.
  The next part is asked once, at the end of setup, default No: send an anonymous count of
  which commands you run - no code, no decisions, no file names, ever. Decline (or don't
  answer - a non-interactive run is never asked) and no usage is sent until you run
  `align telemetry on`. With consent, the payload is the same random id, the command name, and
  the CLI version - plus, on a handful of milestone pings (setup started, an import finishing,
  an agent wired up, the first useful answer), which milestone it was. Nothing else.
- **`align telemetry off` or `DO_NOT_TRACK=1` stops all of it**, the two counts included.
  `ALIGN_TELEMETRY=0` does the same. All three win, in both modes, over everything else
  including a prior `align telemetry on`. Set the env var before your first run and the
  install count is never sent; the wizard then skips the consent question and says why.
- `align telemetry on` / `align telemetry off` change the local-only decision at any time.
  `align telemetry status` prints the effective state and why.

## How the local graph behaves

- Seeds from your git history out of the box. Other sources connect by pasting a **read-only
  personal token you create yourself**. Add `--env local` to any `align import <tool>` run.
- **Why your own token, by design.** This is your personal graph, so the credential is
  yours too: you choose its scope (read-only), you can see exactly what it grants, and you
  can revoke it at the provider any time without involving Align. Tokens are stored on this
  machine and only ever used to read. OAuth sign-in belongs to the personal cloud path,
  where Align's hosted apps do that work with one click.
- **The token page URL is always printed** before Align tries to open your browser,
  so if nothing opens you can click or copy the link from the terminal. A detected
  browser failure says so instead of pretending it worked.
- **GitHub CLI reuse is the exception, not the norm.** Setup checks for an already-signed-in
  `gh`, but only takes its token when GitHub itself confirms it cannot write - and a plain
  `gh auth login` mints a token with the `repo` scope (read *and* write), which fails that
  check. In practice this means most setups are asked to paste a fine-grained read-only
  token anyway; the reuse is a convenience for the minority who already minted one.
- **Re-importing is safe.** A decision is identified by its source URL and title, so running the
  same import twice updates what changed rather than duplicating the graph.
- **Re-running setup is additive.** `align setup --local` a second time skips the git scan
  when this repo's history is already in your graph and the docs read when its docs are (it
  names `align import git --env local` and `align import docs --env local` as the refresh
  commands; a repo with no GitHub or GitLab remote re-reads its docs, which is quick), lists
  the tools you already connected as *connected*, and only fetches what you pick. Pick a
  connected tool to re-import it with its saved token, or to replace an expired one; a
  saved token the provider rejects is forgotten on the spot so the tool stops reading as
  connected. So adding Teams after GitHub and Slack means: run setup, pick Teams, paste one
  token, done.
- Related decisions surface on-device by semantic similarity. Typed relationships (supersedes,
  conflicts with, depends on) are typed at query time using **your own AI provider key**.
  Without one, related decisions still surface, just not typed. The heavier cross-tool
  relationship detection runs in the hosted gateway.
- **The graph is one file, not one file per repo - and it now knows which repo each decision
  came from.** Every hosted commit/pull/issue URL stamps its own repo automatically at import
  time; a Jira ticket, a Slack thread, or a bare `capture` stays unattributed rather than
  misattributed. `ask`, `search` and `decisions list` default to the repo you are standing in
  **plus** every unattributed decision - never a strict repo-only view, since that would hide
  every non-code decision from inside any one repo. Add `--all` to search everywhere, or
  `--repo <name>` (a short name, `owner/repo`, or the full identity) to target another repo by
  name. Two clones of the same remote group under one identity automatically.
- `align local status` inspects the graph, `align local reset` wipes it.

## What works locally today

**Works:** `setup`, `import <tool>`, `capture`, `ask`, `search`, `decisions list`,
`decisions show`, `check`, `status`, `context sync`, `mcp`, and the `local` commands.

**Not yet routed to the local graph** (they address the cloud gateway): `export`,
`drift`, `links`, `spaces`, `check --resolve`, and the connector-scan commands under
`align import`.

## Install notes

Two ways to install, and local-only mode works fully in both.

| | Standalone binary (`install.sh`) | npm (`npm i -g @aligndottech/cli`) |
|---|---|---|
| Needs Node on your machine | no | yes, 22.16+ |
| Cloud mode | yes | yes |
| Local graph, capture, `local status`, `context sync` | yes | yes |
| On-device embeddings, so `ask`/`search`/`check` in local mode | yes | yes |
| Embedding backend | WASM, bundled in | native (`onnxruntime-node`) |

The two backends run the same quantized model and produce the same vectors: measured cosine
agreement 1.000000000, worst per-dimension difference 2.98e-08, and the pairwise similarity
that retrieval actually ranks on shifts by 2.1e-08. So a binary and an npm install can share
one local graph, and you can move between them.

The binary carries its embedding runtime inside itself, so the only thing local mode downloads
is the model below. Cloud mode downloads nothing and needs no native build.

Local-only mode uses an on-device embedding model (`@huggingface/transformers`, an optional
dependency) that ships native binaries for macOS, glibc Linux and Windows (x64/arm64). On those
platforms `npm i -g` just works.

On Alpine/musl, uncommon architectures, or behind a strict proxy, the optional model may not
install. The global install still succeeds and cloud mode works, and local-only mode will tell
you the model is unavailable rather than failing silently.

The first import downloads the model from huggingface.co (~23MB) once, and nothing local can be
embedded or searched until that succeeds. On a restricted network, check that host is reachable
before you begin.
