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
  your decisions, your code, or any file content to us. It sends anonymous usage counts, and
  tells you so once, before the first one; `align telemetry off` or `DO_NOT_TRACK=1` stops all
  of it. See Telemetry below, and [every field](telemetry.md).

Pick cloud on a work email to land straight in your company's graph, local for maximum
privacy. You can start local and move to cloud later.

## What touches the network in local-only mode

Worth knowing before you point it at work content.

- The embedding model downloads once from huggingface.co (~23MB), on the first import.
- `align connect <tool>` calls that tool's API, read-only, with the token you pasted. That's what
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
  `ALIGN_TELEMETRY=0`, or run `align telemetry off`, to turn it off.
- **Local-only mode sends anonymous usage counts, and tells you first.** The first time you
  run `align` in a terminal, it prints a short notice to stderr saying what is sent and how to
  stop it. Nothing is sent before that notice, and a run with no terminal (piped, a hook, cron,
  `docker build`, an agent's shell tool) shows none and sends nothing. After it: a random id generated once for this machine,
  the CLI version, your OS on the first run, the command name (never its arguments), and on a
  handful of milestone pings (setup finished, an import finishing, an agent wired up or
  opened, the first useful answer) which milestone it was, plus a count and the agent's name
  for a session import. Never code, decision text, or file, repo or org names.
- **Nothing is sent from CI**, and the notice is not shown there. Nothing is ever sent by the
  commands align's hooks run (`align check --hook`, `align check --advisory`,
  `align context inject`). `align mcp`, or a run inside an agent `align` opened, does not show the notice, so it
  sends nothing until the notice has printed in your own terminal.
- If an earlier version asked you at the end of setup and you said No, that stands as off:
  nothing is sent, in either mode, the two counts included, until you run
  `align telemetry on`.
- **`align telemetry off` or `DO_NOT_TRACK=1` stops all of it.** `ALIGN_TELEMETRY=0` does the
  same. All three win, in both modes, over everything else including a prior
  `align telemetry on`. Set the env var before your first run and the install count is never
  sent, and the notice is not shown.
- `align telemetry on` / `align telemetry off` change the decision at any time. `off` also
  stops cloud-mode events.
  `align telemetry status` prints the effective state and why.

## How the local graph behaves

- Seeds from your git history out of the box. Other sources connect by pasting a **read-only
  personal token you create yourself**. Add `--env local` to any `align connect <tool>` run.
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
  names `align connect git --env local` and `align connect docs --env local` as the refresh
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
- **Two relationship detectors, chosen by where your model runs.** With a hosted model key set
  (Anthropic, OpenAI and the like), the default is `v1`, the same detector the hosted product runs. With
  no hosted key, and a local Ollama model instead, the default is `v0`, the pairwise classifier, because
  `v1` loses recall on small local models. Override either with `ALIGN_DETECTOR=v0|v1`, or save a choice
  with `align config detector v0|v1`. `v1` is the
  detector the hosted product's base prompt uses: one call per check over every related
  decision, shown with its date and whether it was replaced. The model only says whether two
  decisions are *incompatible*; whether that is a conflict or a replacement is worked out from
  the dates, and anything unclear stays a conflict. Your local graph does not record who made
  each decision, so v1 never assumes two decisions share an author. `v0` types each related
  decision in its own call. Any other value stops the CLI with the allowed values.

  Measured on 183 labelled decision pairs (177 scored), majority of 3 runs, conflict precision
  and recall. The pairs were picked from conflicts the hosted product had already flagged, so
  they are not a held-out test: read these as a comparison between the two detectors, not as
  accuracy you will see on your own graph. Each pair was one call with one related decision and
  no dates, so the benchmark did not exercise v1's many-candidates call or its date rules.

  | Model | v0 precision | v0 recall | v1 precision | v1 recall |
  |---|---|---|---|---|
  | claude-haiku-4-5 | 51/65 (78.5%) | 51/51 (100%) | 51/63 (81.0%) | 51/51 (100%) |
  | claude-sonnet-4-6 | not measured | not measured | 51/65 (78.5%) | 51/51 (100%) |
  | llama3.2 (Ollama) | 46/104 (44.2%) | 46/51 (90.2%) | 30/51 (58.8%) | 30/51 (58.8%) |

  v1 met the preregistered rule on claude-haiku-4-5 (recall no lower than v0's, precision no
  lower than v0's minus its margin of error), but it is not shown to be better than v0 there. **With llama3.2, v1
  finds fewer of the real conflicts (30 of 51 against v0's 46).** So v0 stays the default for
  every model, and v1 is for people who choose it knowingly. Method and full results: align-stack
  `packages/llm-eval/bench-runs/detector-phase-a/`.
- **Links record which detector wrote them.** Links the v0 detector wrote are stamped `v0`, and
  are never re-typed on their own. A link the v1 detector typed is stamped
  `v1`. An untyped `relates` link that no detector judged (classification off, no provider key,
  or a failed call) keeps the `v0` stamp, so relink can still type it. `align sync --classify`
  still types with v0 whatever `ALIGN_DETECTOR` says. Older CLIs keep opening the graph: the
  new column is additive, so the graph's version number does not move. `align local relink --detector v1` re-types links on
  request. It first prints how many model calls it needs, the tokens, and a cost estimate (the
  default model's list price, or "unknown price" for Ollama). On its own it calls nothing;
  `--dry-run --classify` shows the v1 verdicts without writing; `--apply` writes v1 links beside
  the v0 ones and `--apply --replace` swaps them. It asks before spending, stops after 50 calls
  unless `--max-calls` says more, and never touches a link a person marked or judged. A link the
  v1 detector gives no relationship is left exactly as it is.
- **The graph is one file, not one file per repo - and it now knows which repo each decision
  came from.** Every hosted commit/pull/issue URL stamps its own repo automatically at import
  time; a Jira ticket, a Slack thread, or a bare `capture` stays unattributed rather than
  misattributed. `ask`, `search` and `decisions list` default to the repo you are standing in
  **plus** every unattributed decision - never a strict repo-only view, since that would hide
  every non-code decision from inside any one repo. Add `--all` to search everywhere, or
  `--repo <name>` (a short name, `owner/repo`, or the full identity) to target another repo by
  name. Two clones of the same remote group under one identity automatically.
- `align local status` inspects the graph, `align local reset` wipes it.
- **Qwen Code reads a per-session copy of its system settings when bare `align`
  opens it**, so a setting saved at system scope during that session lands in Align's copy
  and is gone next time. Save it at user or workspace scope instead.

## What Align stores on your machine and how it is protected

**What is stored.** In local-only mode everything lives in a few folders in your home directory:

| What | Where (Linux / macOS / Windows) |
|---|---|
| The decision graph: `local.db` plus its `local.db-wal` and `local.db-shm` files | `~/.config/align-cli/` / `~/Library/Preferences/align-cli/` / `%APPDATA%\align-cli\Config\` |
| Settings and the read-only tokens you pasted: `config.json` | the same folder |
| Short-lived state: sync locks, share requests waiting for approval, the last check | `~/.local/state/align-cli/` (Linux and macOS) / `%LOCALAPPDATA%\align-cli\` |
| Editor-hook scratch files: recent check verdicts and which decisions were just shown | `align-<your user id>/` in the system temp folder (`$TMPDIR` or `/tmp`) |
| The embedding model (public, not your data), standalone binary only | `~/.cache/align-cli/models/` / `%LOCALAPPDATA%\align-cli\models\` |

`XDG_CONFIG_HOME` moves the first two rows on Linux. `XDG_STATE_HOME` and `XDG_CACHE_HOME` move the state
and the model cache on Linux and macOS. The graph holds the title
and text of every decision you captured or imported, your marks and notes, and which repo each came from.

**File permissions.** On macOS and Linux every folder above is owner-only (`0700`) and every file in it is
owner-only (`0600`). Align creates them that way whatever your `umask` is. It also checks again each time it
opens them, so a file an older version wrote readable by others is tightened the next time you run a command.
Windows has no such mode bits. There the files sit in your user profile, which by default only you, SYSTEM and
administrators can read. Align does not change those permissions.

**Secrets are removed before anything is saved.** Every capture, every import (git, GitHub, GitLab, Jira,
Confluence, Notion, Linear, Slack, Teams, Zoom, agent sessions, docs), every `align mark` note and the MCP tool
`align_capture` run the same secret scanner `align share` uses. A matched API key, token, password or private
key is replaced with a placeholder such as `<GITHUB_TOKEN>` or `<PRIVATE_KEY>`, and the original is never
written. Align tells you once per run how many it replaced. It is pattern matching, so it catches the common
shapes, not every secret: a password with no label next to it, for example, is kept as written. Decisions saved
by an older version are not scrubbed: an import rewrites most of them with the redacted text, but a decision
you ratified or confirmed keeps the text you attested, and a plain `align capture` is never rewritten.

**Not encrypted, by design.** The graph is a plain SQLite file. Encrypting it would need a key stored on the
same machine, next to the file, so it would protect against very little. It would also need a native database
library, which the CLI deliberately does not ship. **Turn on your operating system's disk encryption**
(FileVault on macOS, BitLocker on Windows, LUKS on Linux). That protects the graph, your tokens and everything
else on the disk if the machine is lost or stolen.

**Backups and sync.** On macOS Align excludes the graph folder from Time Machine (`tmutil addexclusion`,
once). On every system it writes a `CACHEDIR.TAG` file there, which borg, restic, tar and other backup tools
skip when you ask them to leave out caches. That folder also holds `config.json`, so your settings and saved
tokens are left out of those backups too. Neither iCloud nor Dropbox syncs these folders by default. To back
the folder up anyway, run `tmutil removeexclusion <folder>` and delete `CACHEDIR.TAG`. Align does not add them
back: the `.backup-exclusion-done` file next to them records that it already did this once. Both steps are
best effort and never stop a command.

**How to delete everything.** `align local reset` deletes the graph and the saved tokens. To remove every
trace, also delete the folders in the table above, for example on Linux:

```bash
rm -rf ~/.config/align-cli ~/.local/state/align-cli ~/.cache/align-cli "${TMPDIR:-/tmp}/align-$(id -u)"
```

Deleting a file does not overwrite where it was on disk. Disk encryption is what keeps deleted data unreadable.

## What works locally today

**Works:** `setup`, `import <tool>`, `capture`, `ask`, `search`, `decisions list`,
`decisions show`, `check`, `status`, `context sync`, `mcp`, and the `local` commands.

**Not yet routed to the local graph** (they address the cloud gateway): `export`,
`drift`, `links`, `spaces`, `check --resolve`, and the connector-scan commands under
`align connect`.

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
