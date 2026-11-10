# Choosing an access path: API, CLI JSON, or MCP

Align's decision-graph check is reachable three ways:

- the gateway's public **API** (`POST /alignment/check` and friends), for a runtime with its
  own direct integration
- the installed CLI's **`--json`** flags (`align check --json`, and `align ask --json` for
  search), for a shell-capable agent
- the **MCP server** (`align mcp`, or the hosted `mcp-align` connector), for an MCP-native
  client

The alignment check (`/alignment/check`) is the same route behind the API, `align check --json`
and the MCP tool `align_check_alignment`. Search is likewise the same route (`/decisions/smart-search`)
behind the API, `align ask --json` and `align_ask`. `align ask --json` returns matching decisions,
not an alignment verdict. In local mode the CLI and `align mcp` run the same logic in-process, with
no gateway call. So this is not a speed ranking or a "which is faster" claim. This
page is about which one a given runtime should default to.

## The matrix

| Runtime capability | Preferred path | Why |
|---|---|---|
| Has its own direct API/SDK credentials configured | **API** | It's already a bespoke integration; a structured call is the natural fit, and neither the CLI process nor an MCP round trip adds anything. |
| Can execute a shell, no direct API credentials | **CLI JSON** | The installed CLI is a reasonable default when it's configured for the intended graph - no separate client library needed. |
| Is itself an MCP client with no shell available | **MCP** | MCP is first-class here. Forcing a shell-capable-only agent's workflow onto a client that has none is the wrong trade. |

Direct API credentials always win when present, even if the runtime also has a shell or is
MCP-native - it's already the most specific signal available. Shell capability wins over MCP
capability when both are present, because the CLI is the lighter-weight default; a no-shell
MCP client only reaches for MCP because nothing else is available to it, not because MCP is
being avoided elsewhere.

The decision table is implemented as a small, pure function -
[`src/lib/access-capability.ts`](../src/lib/access-capability.ts) - exhaustively tested over
all 8 input combinations in
[`src/__tests__/access-capability.test.ts`](../src/__tests__/access-capability.test.ts). It
does no capability *detection* itself (no filesystem or TTY reads) - it only decides, given
already-known booleans, which path to recommend. Nothing calls it yet. Detection and wiring the recommendation into
`align` is tracked separately.

## What this is not

- **Not a forced migration.** An existing MCP-native or CLI-native setup keeps working exactly
  as it does today; this matrix informs new setup, it does not retroactively change how a
  configured client is treated.
- **Not a fallback mechanism.** Choosing a *preferred* path at setup time is a different problem
  from *falling back* from one path to another mid-session after a failure - that needs its own
  idempotency and auth-safety guarantees (never retry across interfaces on an auth denial, never
  double-spend on a cross-interface retry after a timeout) and is intentionally out of scope
  here.
- **Not a universal speed claim.** No path is asserted to be faster in general.
