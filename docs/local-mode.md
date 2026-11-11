# Cloud or local-only

`align` offers two modes. With no team login, setup runs local-only. A team login sends it to the team graph.

- **Cloud** (a team login). Your graph is hosted at Align: synced across machines, backed up, and
  cross-tool relationship detection runs server-side. Connectors connect via **read-only
  browser OAuth**, and `align ask` retrieval runs server-side. Which tenant you land in is
  decided by the server. A personal email doesn't get a
  cloud graph, so solo use is local-only. A team graph comes by invitation (`align join`) or,
  for a new team, a call (`align share` with no login prints the booking link).
- **Local-only** (`align --local`). **No account, and no Align servers.** The graph,
  embeddings and search all live in a SQLite database on your machine, and the CLI never sends
  your decisions, your code, or any file content to us. The one deliberate exception is
  `align share`, which sends only what you choose to share with your team, after a preview and
  your own yes. It sends anonymous usage counts, and
  tells you so once, before the first one; `align telemetry off` or `DO_NOT_TRACK=1` stops all
  of it. See Telemetry below, and [every field](telemetry.md).

Join a team graph to share decisions with your company, local for maximum privacy. You can
start local and move to cloud later.

## What touches the network in local-only mode

Worth knowing before you point it at work content.

- The embedding model downloads once from huggingface.co (~23MB), and the native runtime for your OS (npm install only, about 20MB to download and up to about 46MB unpacked) once from a GitHub release, on the first import. Both are checked against SHA-256 values built into the CLI before they are kept, and cached under `$XDG_CACHE_HOME/align-cli` (`~/.cache/align-cli`, or `%LOCALAPPDATA%\align-cli` on Windows), never inside the install.
- **The first run in a repo whose origin is on github.com reads that repo's recent merged pull
  requests** from api.github.com. It does not ask first. It needs no token: without one it reads
  up to 300 PRs. If your `gh` login is found and GitHub confirms its token cannot write, Align
  uses it and reads up to 1,000, with a 10 second limit overall. The repo's owner and name are in
  that request to GitHub. Only PRs whose description states a reason are stored. Nothing goes to
  Align.
- `align connect <tool>` calls that tool's API, read-only, with the token you pasted. That's what
  an import is. The data goes from your tool to your machine. None of it goes to Align. Choosing
  what to read (a Jira project, a Linear project, Confluence spaces, Notion pages, whether a
  GitHub repo is public) makes read-only calls to the same APIs.
- **After you connect a tool, Align re-reads it in the background** when you start `align`, with
  the same saved token. It starts one refresh per source at most every 15 minutes, about 20 seconds
  after launch, only in a terminal and never in CI. It says so once. `align sync --off` turns it
  off, and so does `ALIGN_NO_SYNC`.
- **Only when an AI provider is available** (an API key in your environment or saved by
  `align ai`, a custom `ALIGN_LLM_BASE_URL` endpoint, or a running Ollama, which needs no key)
  three surfaces call **your own provider**:
  - `align ask` sends your question plus, for each decision it retrieved (up to `--limit`,
    default 8), the title, source, date and the stated reason. If no reason is stated it sends a
    240-character excerpt instead.
  - `align check` and the MCP tool `align_check_alignment` send the proposed change, cut only to
    fit your model's context window, paired with one retrieved decision at a time.
  - The editor hook never does by default. It's retrieval only, provider or no provider. Adding
    `--block-on-critical` to your hook line opts that hook into background adjudication on the
    same terms as `align check`, roughly once per edit where retrieval found something.
- Ollama runs on your own machine by default, so those calls stay local, unless you've pointed
  `OLLAMA_HOST` at another box.
- **Bare `align` opens a coding agent, and that agent talks to its own model provider.** It runs
  either Align's engine on your key or Ollama, or your own Claude Code. What the agent reads and
  writes in that session goes to that provider, not to Align. Typed relationships (below),
  `align sync --classify` and `align local relink` also call your provider.
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
  for a session import, the agent's name when `align` opens it, and for each source a sync
  finishes, the kind of source (such as `github`), how many items it stored, how it went and
  what started it. Never code, decision text, or file, repo or org names.
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

- Seeds from your git history, the repo's ADRs, CLAUDE.md and AGENTS.md, and (for a GitHub
  origin) recent merged PR descriptions that state a reason, out of the box. No token needed. Other sources connect by pasting a **read-only
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
- **Re-running setup is additive.** `align --local` a second time skips the git scan
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
- **One relationship detector, the same one the hosted product runs.** `v1` is the default. It sends
  all related decisions in one call and asks whether any is incompatible with the new one. The model
  only says whether two decisions are *incompatible*; whether that is a conflict or a replacement is
  worked out from the dates, and anything unclear stays a conflict. Your local graph does not record who
  made each decision, so v1 never assumes two decisions share an author. `v0` is the older pairwise
  classifier, one call per related decision. Choose it with `ALIGN_DETECTOR=v0` or
  `align config detector v0`. Any other value stops the CLI with the allowed values.

  Local model: the CLI uses `qwen2.5:7b` when it is installed (`ollama pull qwen2.5:7b`). It is the
  local model that passes the v1 detector on our labelled pairs. The 3B `llama3.2` does not: it found
  30 of 51 real conflicts against v0's 46. So with no hosted key and any local model other than qwen2.5
  (at its default size or 7B and above), the default is `v0`. A hosted key, `ALIGN_DETECTOR` or
  `align config detector` overrides that, in either direction.

  Measured on 183 labelled decision pairs (177 scored), majority of 3 runs, conflict precision and
  recall. The pairs were picked from conflicts the hosted product had already flagged, so they are not a
  held-out test: read these as a comparison between detectors and models, not as accuracy on your graph.

  | Model | Detector | precision | recall |
  |---|---|---|---|
  | claude-haiku-4-5 | v0 | 51/65 (78.5%) | 51/51 (100%) |
  | claude-haiku-4-5 | v1 | 51/63 (81.0%) | 51/51 (100%) |
  | qwen2.5:7b (Ollama) | v1 | 46/70 (65.7%) | 46/51 (90.2%) |
  | llama3.2 (Ollama) | v0 | 46/104 (44.2%) | 46/51 (90.2%) |
  | llama3.2 (Ollama) | v1 | 30/51 (58.8%) | 30/51 (58.8%) |

  Method and full results: align-stack `packages/llm-eval/bench-runs/detector-phase-a/`.
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
| The decision graph: `local.db` plus its `local.db-wal` and `local.db-shm` files | `~/.align/` (on every platform) |
| Settings: `config.json`. It also holds the read-only tokens you pasted only when your OS has no credential store (otherwise they are in the Keychain, Secret Service or, on Windows, an encrypted `token-blobs.json`; see [Importing](importing.md#local-mode-tokens-where-they-live-and-how-to-supply-them)). It also holds any AI provider key you saved with `align ai` and your per-repo choices of what to read from each connected tool (project keys, page ids and names, "skip in this repo"), keyed by the repo's identity | the same folder |
| Short-lived state: sync locks, share requests waiting for approval, the last check | `~/.local/state/align-cli/` (Linux and macOS) / `%LOCALAPPDATA%\align-cli\` |
| Editor-hook scratch files: recent check verdicts and which decisions were just shown | `align-<your user id>/` in the system temp folder (`$TMPDIR` or `/tmp`) |
| The embedding model (public, not your data), on both installs, and the native runtime on npm installs | `~/.cache/align-cli/models/` / `%LOCALAPPDATA%\align-cli\models\` |
| Files `align` writes to start your agent | `~/.cache/align-cli/launch/` (`$XDG_CACHE_HOME`, or the OS cache folder) |

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

**Files outside those folders.** The setup wizard asks before it writes your coding agent's
config (the MCP entry, hooks and rules, including a `.mcp.json` in the repo). `align context sync`
writes `.align/decisions.md` in the repo. Align remembers each file it wrote into another tool's
config, and `align use --undo` restores them.

**How to delete everything.** `align local reset` deletes the graph and the saved tokens. To remove every
trace, also delete the folders in the table above, for example on Linux:

```bash
rm -rf ~/.align ~/.config/align-cli ~/.local/state/align-cli ~/.cache/align-cli "${TMPDIR:-/tmp}/align-$(id -u)"
```

Deleting a file does not overwrite where it was on disk. Disk encryption is what keeps deleted data unreadable.

## What works locally today

**Works:** bare `align` (the setup wizard, or `align --local`), `import <tool>`, `capture`, `ask`, `search`, `decisions list`,
`decisions show`, `check`, `status`, `sync`, `context sync`, `mcp`, and the `local` commands.

**Not yet routed to the local graph** (they address the cloud gateway): `export`,
`drift`, `links`, `spaces`, `check --resolve`, and the connector-scan commands under
`align connect`.

## Install notes

Two ways to install, and local-only mode works fully in both.

| | Standalone binary (`install.sh`) | npm (`npm i -g @aligndottech/cli`) |
|---|---|---|
| Needs Node on your machine | no | yes, 22.19+ |
| Cloud mode | yes | yes |
| Local graph, capture, `local status`, `context sync` | yes | yes |
| On-device embeddings, so `ask`/`search`/`check` in local mode | yes | yes |
| Embedding backend | WASM, bundled in | native ONNX Runtime, downloaded on first use |

The two backends run the same quantized model and produce the same vectors: measured cosine
agreement 1.000000000, worst per-dimension difference 2.98e-08, and the pairwise similarity
that retrieval actually ranks on shifts by 2.1e-08. So a binary and an npm install can share
one local graph, and you can move between them.

The binary carries its embedding runtime inside itself, so the only thing local mode downloads
is the model below. Cloud mode downloads nothing and needs no native build.

Local-only mode uses an on-device embedding model. The npm package is small (about 45MB installed): the
native ONNX Runtime for your platform (macOS arm64, glibc Linux x64/arm64, Windows x64/arm64) is
downloaded the first time local mode needs it, not installed by npm. Cloud mode never needs it.

On Alpine/musl, Intel Macs or other architectures there is no runtime to download. The install still
succeeds, cloud mode works, and local-only mode tells you so rather than failing silently.
`align doctor` reports whether the runtime and model are present and fetches them if not.

The first import downloads the model from huggingface.co (~23MB) and the runtime from github.com once,
and nothing local can be embedded or searched until both succeed. On a restricted network, check those
hosts are reachable before you begin, or point `HF_ENDPOINT` and `ALIGN_ORT_RUNTIME_URL` at a mirror
(the SHA-256 check still applies). An agent hook never downloads: it reports "could not check" until
the first import has run.
