# Alignment check

Check your current changes against the decision graph.

```bash
align check          # the staged diff (falls back to the HEAD diff when nothing is staged)
align check --all    # the full working-tree diff vs HEAD
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Aligned, or nothing related found |
| `1` | Conflict |
| `2` | Retrieved decisions it could not adjudicate, or could not run at all |

`2` is not a pass, and it is deliberately distinguishable from a conflict. That contract is
guaranteed under `--ci`. In default interactive mode a transport error or a missing git
repository also exits `1`.

## Modes

| Mode | Behavior |
|------|----------|
| (default) | Human-readable output. Exits `1` on any conflict. |
| `--hook` | Pre-commit mode. Silent when there's no context, only fails on **critical** conflicts. |
| `--advisory` | Agent hook mode. **Always exits 0**, emits related unadjudicated decisions, or an explicit "could not check" notice, in the host's hook shape (`--format claude\|gemini\|pi\|opencode\|text`). Fail-open. |
| `--advisory --block-on-critical` | Opt-in deferred adjudication. See below. |
| `--ci` | JSON to stdout, and the exit contract above. **Pass `--base`** or there is nothing to diff. |

`--advisory` detects pre versus post from the hook payload on stdin.

### What `--block-on-critical` changes

When retrieval finds related decisions, the hook additionally spawns a background full check,
and a **retry of a change already judged a critical conflict is denied** (Claude Code
`permissionDecision: "deny"`). The verdict expires after 15 minutes.

It's keyed on the tool, the target file and the text together, so a different file or an
adjusted approach proceeds untouched. It catches a re-presentation, never a first proposal.
Runs per edit, up to 3 at a time per project.

In local mode it calls **your own AI provider**, which the default hook never does.

## Useful flags

| Flag | What it does |
|---|---|
| `--title "what this change decides"` | Improves adjudication on a bare diff |
| `--base <ref>` | Diffs `base...HEAD` instead of the staged diff |
| `--depth related\|full\|exhaustive` | How deep an answer to request |

`related` is retrieval only. `exhaustive` adjudicates everything retrieved, for a strict CI gate
whose `fail-on` treats unknown as a failure. `--depth` is ignored under `--advisory`, which is
retrieval only by design.

## In CI

Always pass `--base`. A clean checkout has no staged diff, and a check with nothing to diff
passes without looking.

```yaml
- name: Check alignment
  run: align check --base origin/${{ github.base_ref }} --ci
  env:
    ALIGN_TOKEN: ${{ secrets.ALIGN_TOKEN }}
```

Or use the published GitHub Action, which always passes `--base`, writes the verdict to the job
summary and annotates the changed files:
[`aligndottech/decision-check`](https://github.com/aligndottech/decision-check).

## Answering a check

When a check flags a conflict, resolve it so it stops surfacing. This is only meaningful while
the current diff is conflicting.

```bash
align check --resolve <decision_id>:honored      # or overridden | context_changed
```

An exit `2` can also mean the judge reached your change and declined to rule, which no re-run
will change on its own. Answer it once, using the event id the failing check prints:

```bash
align adjudicate <event-id> --verdict accepted --note "why this may proceed"
```

`--verdict conflicting` records the opposite. The answer is matched against a digest of the
content that was checked, so re-running the check on the same change finds it, and answering
something you were never shown is not available.
