# ALI-414: an explicit "needs a human" state for the CLI alignment check

**Ticket:** [ALI-414](https://linear.app/aligndottech/issue/ALI-414) (Urgent, due 2026-08-08)
**Branch:** `tnk/ALI-414`
**Baseline on main:** 332 tests / 39 files passing.

## The bug

`AlignmentResult.status` is `aligned | conflicting | no-context`. There is no way to say
"I could not check." So every failure of the local classifier is forced into `aligned`.

`local-gateway-client.ts:169-175` is the fail-open:

```ts
const anyTyped = typed.some(t => t.typed);
const status = conflicts.length ? 'conflicting' : 'aligned';   // <- unclassified == aligned
```

`classifyRelationship` returns `null` for **three different reasons** - no LLM key
configured, the provider call failed or timed out, and unparseable/out-of-vocabulary
output - and the caller cannot tell them apart. A human might read the API-key hint in
`message`; an agent branching on `status` reads `aligned` and proceeds past a
contradicting decision. An unset key is the default state of a fresh `npm i
@aligndottech/cli`, so this is the normal first-run path.

## The name: `unknown`, not `uncertain`

The ticket proposes `uncertain` (or `needs-review`) and leaves the name open. **The
gateway already shipped this exact concept as `unknown`** under ALI-348 -
`services/gateway/src/routes/alignmentRoutes.ts:56-68` returns
`{ status: 'unknown', reason: 'brain_timeout' | 'brain_error' | 'brain_degraded' }`,
verified by reading the construction, not the ticket.

A second spelling for one concept is the "a type and a database constraint are two
writers of one fact" drift from `code-style.md`: an agent consuming both the cloud and
local clients would have to branch on two names for the same state. So the CLI adopts
`unknown` and the gateway's `reason` field.

## A second, unlisted fail-open this fixes

Because `unknown` is missing from the CLI union, a **cloud** gateway already returning
`unknown` today falls into `check.ts`'s final `else` and prints:

> No related decisions found in your graph.

That is a live mislabelling of "could not check" as "nothing found", in the cloud path,
on the current published CLI. Adding the branch fixes it.

## Reason codes: only what the CLI can honestly distinguish

`callChat` returns `null` for a missing key AND for a timeout AND for a non-2xx - so the
classifier cannot claim to know which unless it asks first. It gets one cheap, honest
signal: whether any provider is configured at all (a synchronous env check).

| Reason | Derived from | Ticket case |
|---|---|---|
| `no_llm_key` | `callChat` -> null AND no provider configured | 1 |
| `classifier_error` | `callChat` -> null AND a provider IS configured | 3 |
| `classifier_unparseable` | text returned, but no JSON / not in the canonical vocabulary | 5 |

Not adding `classifier_timeout`: the CLI genuinely cannot tell a timeout from a 429 or an
empty body, and inventing a code for it would be a claim the code cannot support.

(Caveat, commented in source: with no env key but a reachable Ollama that fails, the
reason is `no_llm_key`. The remedy it points at - configure a provider - is still right.)

## The aggregation rule

```
any typed conflict            -> conflicting   (a found conflict still wins)
no candidates retrieved       -> no-context    (embeddings are local; nothing to be unsure about)
any candidate unclassified    -> unknown       (the unclassified one could be the conflict)
all classified, none conflict -> aligned
```

## Exit codes for `align check`

| Mode | `unknown` | Why |
|---|---|---|
| default | **exit 2** | Never a green header. 2, not 1, so a script can tell "conflict" from "could not check". |
| `--ci` | **exit 2** | CI is exactly where a silent green is worst. |
| `--hook` | exit 0, but **prints a notice** | Documented contract: "only fail on critical conflicts". Blocking every commit of a user with no LLM key gets the hook uninstalled. Not silent, though - "could not check" is not "no context". |
| `--advisory` | exit 0 | Contract is always-exit-0; untouched. |

## Test list

Two examples per rule where the rule generalises.

1. Local: no LLM key + a retrieved candidate -> `unknown`, `reason: 'no_llm_key'`,
   relevant decisions still returned, key hint survives in `message`.
   (Replaces the test at `local-gateway-client.test.ts:111-120`, which currently **pins
   the bug** by asserting `aligned`.)
2. Local: every candidate classified confidently as a non-conflict -> `aligned`.
   (The pair for #1: proves the happy path was not renamed.)
3. Local: provider configured, call fails -> `unknown`, `reason: 'classifier_error'`.
4. Local: unparseable classifier output -> `unknown`, `reason: 'classifier_unparseable'`.
5. Local: a typed conflict alongside an unclassified sibling -> `conflicting`
   (conflict wins over unknown - the second example for the aggregation rule).
6. `align check` on `unknown` -> exit 2 and no green "Aligned" header.
7. `align check --ci` on `unknown` -> exit 2, JSON still written to stdout.
8. `align check --hook` on `unknown` -> exit 0 (never blocks a commit) and prints a notice.
9. `align check` on a cloud `unknown` does not print "No related decisions found".
10. Classifier: each of the three failure causes reports its own reason (replaces five
    `toBeNull()` assertions that pin the collapse).
11. MCP: `align_check_alignment`'s description tells the agent `unknown` means stop and
    ask the human; server instructions say the same.

## Files

- `src/lib/gateway-client.ts` - add `unknown` to the union, add `reason`.
- `src/lib/local-llm.ts` - export `hasConfiguredProvider()`.
- `src/lib/local-relationship-classifier.ts` - return an outcome with a reason, not `null`.
- `src/lib/local-gateway-client.ts` - aggregation rule.
- `src/commands/check.ts` - the `unknown` branch + exit codes.
- `src/commands/mcp.ts` - tool description + server instructions.

## Out of scope (noted, not changed)

`check.ts:68-71` - the `--ci` `catch` writes `{status:'error'}` and **exits 0** when the
gateway is unreachable. Same family of fail-open, but changing it would alter the exit
code of every CI user whose gateway blips, and the ticket does not ask for it. Worth its
own ticket.
