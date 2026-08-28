# Cloud or local-only

`align setup` offers two modes.

- **Personal cloud** (default). Your graph is hosted at Align: synced across machines, backed
  up, and upgradeable to a shared team workspace. Connectors connect via **read-only browser
  OAuth**, and `align ask` retrieval runs server-side.
- **Local-only** (`align setup --local`). **No account, and no Align servers.** The graph,
  embeddings and search all live in a SQLite database on your machine, and the CLI never sends
  your decisions to us.

Pick cloud for sync and the team upgrade path, local for maximum privacy. You can start local
and move to cloud later.

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

## How the local graph behaves

- Seeds from your git history out of the box. Other sources connect by pasting a **read-only
  personal token**, since OAuth needs the hosted callback and isn't available offline. Add
  `--env local` to any `align import <tool>` run.
- **Re-importing is safe.** A decision is identified by its source URL and title, so running the
  same import twice updates what changed rather than duplicating the graph.
- Related decisions surface on-device by semantic similarity. Typed relationships (supersedes,
  conflicts with, depends on) are typed at query time using **your own AI provider key**.
  Without one, related decisions still surface, just not typed. The heavier cross-tool
  relationship detection runs in the hosted gateway.
- `align local status` inspects the graph, `align local reset` wipes it.

## What works locally today

**Works:** `setup`, `import <tool>`, `capture`, `ask`, `search`, `check`, `status`,
`context sync`, `mcp`, and the `local` commands.

**Not yet routed to the local graph** (they address the cloud gateway): `decisions`, `export`,
`drift`, `links`, `spaces`, `check --resolve`, and the connector-scan commands under
`align import`.

## Install notes

Cloud mode needs no native build.

Local-only mode also uses an on-device embedding model (`@huggingface/transformers`, an optional
dependency) that ships native binaries for macOS, glibc Linux and Windows (x64/arm64). On those
platforms `npm i -g` just works.

On Alpine/musl, uncommon architectures, or behind a strict proxy, the optional model may not
install. The global install still succeeds and cloud mode works, and local-only mode will tell
you the model is unavailable rather than failing silently.

The first import downloads the model from huggingface.co (~23MB) once, and nothing local can be
embedded or searched until that succeeds. On a restricted network, check that host is reachable
before you begin.
