# Alignment check

Check your current changes against the decision graph.

```bash
align check          # the staged diff, else the HEAD diff, else (clean branch) the branch vs its base
align check --all    # the full working-tree diff vs HEAD
```

On a clean branch with nothing staged or uncommitted, `align check` reviews the branch against its
detected base and says so. That fallback does not apply under `--ci` or `--hook`.

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
| `--advisory` | Agent hook mode. **Always exits 0**, emits a verdict when one arrives in time (a conflict names the decision and its link), the related decisions with a "could not check in time" line when it does not, or an explicit "could not check" notice, in the host's hook shape (<code>--format claude&#124;codex&#124;cursor&#124;copilot&#124;gemini&#124;pi&#124;opencode&#124;text</code>). Fail-open. |
| `--advisory --block-on-critical` | Opt-in deferred adjudication. See below. |
| `--ci` | JSON to stdout, and the exit contract above. **Pass `--base`** or there is nothing to diff. |
| `--json` | Same output and exit codes as `--ci`. |

`--advisory` detects pre versus post from the hook payload on stdin.

### Ratified rules stop the first attempt

The advisory hook also checks each proposed edit, with no model call, for things that have one
right answer: an email address (not an `example.*`, `.test` or `noreply` one), a card number
that passes the Luhn check, a known credential format (AWS, GitHub, Anthropic, Slack, private
key blocks). A match is a **deny on the first attempt** only when your team has accepted the
matching starter rule (`customer-data-in-tickets`, `no-plaintext-secrets`) in Align, because
a ratified rule is a person saying "enforce this". The message names the rule and the kind of
thing found, never the value. No ratified rule means no deny. This deny does not need `--block-on-critical`: it rests on a rule a person ratified plus a computed match, not on a model's judgement. If the user confirms an edit is intended, set `ALIGN_RULES_ACK=1` for that session.

The tenant's rules are fetched only when the text matches, so an ordinary edit costs no extra
request. If they cannot be read (offline, timeout) the edit proceeds and stderr says
the check was skipped. In local mode there are no starter rules, so nothing is checked and
nothing is printed. Semantic parts of a rule (a name in free text, a pasted contract) are not
matched here. Those wait for `--hook`, the git pre-commit check, which refuses a commit on a
critical conflict, lets a warning through, and never blocks when the check could not run.

### What `--block-on-critical` changes

When retrieval finds related decisions and the verdict does not arrive in the hook's window, the
hook additionally spawns a background full check (a verdict that does arrive is stored for the
retry instead), and a **retry of a change already judged a critical conflict is denied** (Claude Code
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
whose `fail-on` treats unknown as a failure. `--depth` is ignored under `--advisory`, which sets its own:
retrieval first, then, when something related was found, one `full` check that must answer within
about 7 seconds of the hook starting. A timeout falls back to the related decisions with a line
saying the change could not be checked in time; it is never reported as aligned. Local mode skips
the `full` check, because there it calls your own AI provider.

## Secrets in the diff

A rule such as "never commit a real secret" may not be retrieved for a diff, so the judge never weighs it. Align
therefore looks for well-known provider token shapes directly, with no model call, no network and no ratified rule
(GitHub, AWS access key, Slack, Stripe, Google, OpenAI-style, Anthropic, GitLab, Linear, a password inside a URL, a
private key). A hit names the kind, the file and the line, never the value.

**Covered**

- **Edit time:** the agent hook (`align check --advisory`, PreToolUse on Write and Edit) refuses the FIRST attempt
  to write new text holding one. It works in local mode. `ALIGN_RULES_ACK=1` is the session break glass.
- **`align check` and the pre-commit hook:** a hit in the lines the change ADDS is a critical conflict and exits `1`.
- **CI:** `align check --ci --base <ref>` does the same and still flags when the judge is down.

**Not covered**

- A secret written by a shell command (`echo TOKEN > f` in a Bash tool call): the edit hook only reads Write and Edit.
- `git commit --no-verify`, which skips the pre-commit hook (CI still checks the pull request).
- Token shapes not on the list, and a secret split across lines.
- `--advisory` after the fact (PostToolUse): the edit has landed, so nothing is refused there.

Not flagged: public key fingerprints (`SHA256:...`), documented examples (`AKIA...EXAMPLE`, Stripe's published
test key, the AWS documentation secret), and placeholders such as `sk-your-key-here`, or a URL password that is
`${VAR}`, `<password>`, `changeme`, `TOKEN`, equal to the user name or one repeated character. A private key header
counts only with a body: on the same line, or in the next few added lines.

**Escape hatch:** write `align:allow-secret` as its own token on the same line, or on the added line directly above,
to say a secret-shaped value is deliberate (a test fixture, a doc example). When it suppresses something, the output
says so in a note. Nothing else turns the check off. A `--resolve` naming a secret finding is ignored, because the
finding is not a decision.

## Co-change rules

Some rules are about which files a PR touches, not what the diff says: "every notable API change adds
an entry to `docs/changelog.md` in the same PR". A missing file is not in a diff, so the judge cannot
see it. A co-change rule is checked from the changed-file list instead, with no model call:

```
align rule add "Every notable API change adds a changelog entry" \
  --when "openapi/**" --require docs/changelog.md
```

`align check` flags a change that touches any `--when` path and none of the `--require` paths. The
flag is a critical conflict that cites the rule's decision, names the files that triggered it and the
file that is missing. It runs beside the judge, so it still flags when the judge is down or cannot
parse its answer. The file list is the same change the diff came from (`--base <ref>`, staged, or
the working tree), and a rename counts as touching both the old path and the new one.

A rule belongs to the repo you were in when you added it, so it does not fire in your other
checkouts (a rule added outside a git repo applies everywhere). Globs support `*`, `**` and `?`
only: `{a,b}`, `[abc]`, `!` and backslash are refused when you add the rule, because they would
otherwise never match. Write one path per alternative. `align rule remove <id>` (the id is in
`align rule list`) deletes a wrong rule and keeps its decision.

A rule conflict has no per-PR waiver. It is computed, so there is no judge to overrule and no
mark that hides it. To let one PR through, remove the rule or add the file it asks for.

Local mode only for now. The pre-commit `--hook` and the agent `--advisory` hooks do not evaluate
these rules: they see one commit or one edit, and a same-PR rule cannot be judged from either.
`align rule list` shows what is stored.

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

## In CI with a decisions file, no account

A team that keeps its decisions in the repo can fail a pull request that goes against them, with
its own AI provider key and nothing else. Commit the file `align up --out DECISIONS.md` writes,
then check each PR against it:

```bash
align check --ci --base origin/main --decisions-file DECISIONS.md
```

The decisions come from the file, not a graph. No account, no MCP server and no local graph are
needed. The only network call is the one to your provider (the first key it finds: `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and the others in [Configuration](configuration.md)). It sends
the diff, cut to fit your model's context window, and the decisions in the file. By default that is
one call per check.

Every decision in the file is judged, not only the ones that look similar to the diff. The file is
the short list, so there is nothing to retrieve. A conflict is a decision the change contradicts or
reverses.

| Exit | Meaning |
|---|---|
| `0` | Checked against the file, no conflict. Also when `--base` finds no changes at all. |
| `1` | The diff goes against a decision. The JSON on stdout names it and gives the reason. |
| `2` | The check could not run: no provider key, a rejected key, a provider answer it could not read, a file that is missing, and a file with no decisions in it. |

Exit `2` is never a pass. That includes a non-empty file that holds no decisions: a check against
nothing would pass every change, so it fails instead. The `Agent-decided, not yet ratified` section
of the file is not checked against, because the file itself says not to treat those as governing.

Put this in `.github/workflows/align.yml`:

```yaml
name: Align
on:
  pull_request:

jobs:
  decisions:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the check diffs against origin/<base>, which needs history
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --global @aligndottech/cli
      - name: Check the pull request against DECISIONS.md
        run: align check --ci --base "origin/$BASE_REF" --decisions-file DECISIONS.md --title "$PR_TITLE"
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          # Through env, never pasted into the script: a PR title is text anyone can write.
          BASE_REF: ${{ github.base_ref }}
          PR_TITLE: ${{ github.event.pull_request.title }}
```

Add `OPENAI_API_KEY` under the repository's Settings, Secrets and variables, Actions.
`--title` is optional. It tells the judge what the change decides, which a bare diff does not.

GitHub does not give secrets to pull requests from forks, so on those the job has no key and
fails with exit `2`. That is the safe direction. Do not switch to `pull_request_target` to get
around it: that runs with your secrets against code from the fork.

`--decisions-file` cannot be combined with `--hook`, `--advisory` or `--resolve`. They stop with exit `2`.

## Answering a check

When a check flags a conflict, resolve it so it stops surfacing. This is only meaningful while
the current diff is conflicting.

```bash
align check --resolve <decision_id>:honored      # or overridden | context_changed
```

An exit `2` can also mean the judge reached your change and declined to rule, which no re-run
will change on its own. Answer it once from a terminal, using the event id the failing check prints. The answer is
recorded as yours, so the command refuses a hook, a pipe or an agent shell:

```bash
align adjudicate <event-id> --verdict accepted --note "why this may proceed"
```

`--verdict conflicting` records the opposite. The answer is matched against a digest of the
content that was checked, so re-running the check on the same change finds it, and answering
something you were never shown is not available.
