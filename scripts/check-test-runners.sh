#!/usr/bin/env bash
# Every shell suite in scripts/__tests__/ must have a workflow step that runs it, in a place a
# PULL REQUEST actually reaches.
#
# CI names each suite on its own `run:` line, so a new one is wired by hand and is trivially
# missed. When that happens the tests exist, pass locally, and gate nothing - and nothing goes
# red, because the absence of a runner has no output. The failure mode of an unrun test is
# silence, which is the whole reason this is a guard and not a convention.
#
# ALI-714 established the first half: a runner must EXIST. ALI-727 added the second: it must be
# somewhere a pull request gets to. Those are different claims, and this repo has two live ways
# to satisfy the first while failing the second, neither visible at the step you are reading:
#
#   1. The workflow never triggers on `pull_request`. Three of this repo's four workflows
#      (e2e-release, promote-release, release-please) fire on release / workflow_dispatch /
#      workflow_run / push-to-main. A suite wired only into one of those runs AFTER the merge
#      it was supposed to block.
#   2. The job is skipped on pull requests. ci.yml's `cross-platform` carries
#      `if: github.event_name != 'pull_request'`. The workflow triggers on PRs, the step is a
#      real `run:` line, and the suite still never executes before a merge. The exclusion sits
#      at the top of the job, which can be fifty lines above the step.
#
# SCOPE, stated so it is not mistaken for more. This checks that a runner exists and that a
# pull request reaches it. It does NOT check that the job carrying it is a REQUIRED status
# check, and in this repo that distinction is not academic: as of 2026-09-12 align-cli's `main`
# has no required_status_checks rule at all. Re-derive rather than trusting this sentence -
# it is a setting, and settings move:
#
#   gh api repos/aligndottech/align-cli/rules/branches/main --jq '.[].type'
#
# That endpoint returns the EFFECTIVE rules (organisation ruleset + repository ruleset) and
# needs only repo read, unlike the org ruleset endpoint which needs admin:org. Today it returns
# deletion, non_fast_forward, pull_request and copilot_code_review - and no status check. So
# every gate in ci.yml, this one included, currently fails honestly and blocks nothing
# (architecture-boundaries.md, "the gate ran, failed correctly, and nothing required it").
# Requiring the `test` context is a ruleset change, not a code change, and is deliberately not
# hardcoded here: a list of required names living in this file would be a second writer of a
# fact that lives in branch protection (code-style.md).
#
# PORTED from align-stack's scripts/check-test-runners.sh, minus its helm-chart half, which
# this repo has no charts for. That makes two copies of one rule in two repos: if you fix a
# defect here, check the other one (code-style.md, "fixed one site, left the identical one").
# They have DIVERGED deliberately since ALI-727 - the PR-reachability half below is here only.
# align-stack's copy carries the same hole and it is worth porting back.
#
# Usage: check-test-runners.sh [repo-root]
set -uo pipefail

ROOT="${1:-.}"

unrun_shell=()       # no workflow invokes it at all
unreachable_shell=() # a workflow invokes it, but no pull request gets there
found=0

# Does this workflow run on pull requests at all?
#
# Read as its own pass over the file rather than folded into the scan below, so the answer does
# not depend on `on:` appearing before `jobs:`. A YAML mapping is unordered, and a guard whose
# verdict flips with key order is a guard that is right by luck.
#
# Recognises `on:` and `"on":` (the quoted form people reach for because YAML 1.1 reads a bare
# `on` as boolean true), in block, flow-sequence and scalar spellings. It does NOT recognise
# `'on':`. An unrecognised spelling makes a workflow read as non-PR-triggering, which is a loud
# red naming the file rather than a silent pass - the safe direction for a miss.
workflow_triggers_pr() { # <file>
  awk '
    { sub(/#.*/, "", $0) }
    # on: [push, pull_request]   or   on: pull_request
    /^("on"|on):[ \t]*[^ \t]/ {
      rest = $0; sub(/^[^:]*:[ \t]*/, "", rest)
      if (rest ~ /(^|[^A-Za-z0-9_])pull_request(_target)?([^A-Za-z0-9_]|$)/) found = 1
      inon = 0; next
    }
    /^("on"|on):[ \t]*$/ { inon = 1; next }
    inon && /^[^ \t]/    { inon = 0 }
    # a key or sequence item naming the event, inside the on: block
    inon && /^[ \t]+-?[ \t]*pull_request(_target)?[ \t]*:?[ \t]*$/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

# The text of `run:` steps, and nothing else.
#
# Stripping comments is not enough. A filename appears in workflow YAML in several places that
# execute nothing - a `paths:` trigger filter, a step `name:`, a cache key, an `if:` expression
# - and crediting any of them is the same defect this guard exists to catch: reading the
# identifier instead of what executes. A whole-file grep would vouch for a suite nothing runs.
#
# Handles single-line `run: cmd` and block scalars (`run: |`, `run: >`), whose continuation
# lines are indented past the `run:` KEY itself. Using the key's column rather than the line's
# leading whitespace matters: a sibling `env:` sits at the same indent as `run:` and must not be
# swept in, while `- run: |` puts the key two columns right of the line start.
#
# With prmode=1 it also tracks which JOB each step belongs to and drops the jobs a pull request
# skips. Job attribution is per-job on purpose: a whole-file rule would let ci.yml's
# cross-platform `if:` disqualify every sibling job in the same file, which is a false red on a
# correctly wired tree.
run_text() { # prmode(0|1) <file...>
  local prmode="$1"; shift
  [ "$#" -gt 0 ] || return 0
  awk -v prmode="$prmode" '
      { sub(/#.*/, "", $0) }
      # Per-file reset. Without it a file ending inside an open `run: |` block makes the next
      # file s leading lines read as run text (align-stack ALI-720).
      FNR == 1 { inblock = 0; injobs = 0; excluded = 0; runcol = 0 }
      {
        if (inblock) {
          if ($0 ~ /^[ \t]*$/) next
          match($0, /^[ ]*/)
          if (RLENGTH > runcol) { if (!prmode || !excluded) print; next }
          inblock = 0
        }

        # A top-level key opens or closes the jobs mapping, and ends any job scope.
        if ($0 ~ /^[A-Za-z_"]/) {
          injobs = ($0 ~ /^jobs:[ \t]*$/) ? 1 : 0
          excluded = 0
        } else if (injobs && $0 ~ /^  [A-Za-z0-9_.-]+:[ \t]*$/) {
          # a new job begins; whatever the last one said about itself does not carry over
          excluded = 0
        } else if (injobs && $0 ~ /^    if:/ && $0 ~ /event_name[ \t]*!=[ \t]*.pull_request/) {
          # JOB-level if: only. Indent 4 is the job s own property; a step s if: sits at 8 or
          # deeper and is usually about a matrix leg, not about events.
          excluded = 1
        }

        if (match($0, /^[ ]*-?[ ]*run:[ ]*[|>]/)) {
          match($0, /run:/); runcol = RSTART - 1
          inblock = 1
          next
        }
        if ($0 ~ /^[ ]*-?[ ]*run:[ ]/) { if (!prmode || !excluded) print }
      }
    ' "$@" 2>/dev/null
}

# Sorted, so the scan does not depend on the order the filesystem hands back.
all_workflows=()
pr_workflows=()
WF_DIR="$ROOT/.github/workflows"
if [ -d "$WF_DIR" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    all_workflows+=("$f")
    workflow_triggers_pr "$f" && pr_workflows+=("$f")
  done < <(find "$WF_DIR" -type f \( -name '*.yaml' -o -name '*.yml' \) | sort)
fi

WF_TEXT_ALL=$(run_text 0 "${all_workflows[@]+"${all_workflows[@]}"}")
WF_TEXT_PR=$(run_text 1 "${pr_workflows[@]+"${pr_workflows[@]}"}")

# Match with a herestring, NOT `printf ... | grep -q`.
#
# That pipeline is wrong under `set -o pipefail`, and wrong only at scale: grep -q exits the
# instant it matches, printf takes SIGPIPE, and pipefail reports the pipeline as failed even
# though the match succeeded - so every suite reads as unrun. Small fixtures never trigger it,
# because printf finishes before grep can exit, which is how align-stack's copy shipped green
# unit tests over an inverted guard. The test suite's first case runs against this real repo
# for exactly that reason.
has_ref()    { grep -qF -- "$1" <<<"$WF_TEXT_ALL"; }
has_pr_ref() { grep -qF -- "$1" <<<"$WF_TEXT_PR"; }

if [ -d "$ROOT/scripts/__tests__" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    found=$((found + 1))
    base=$(basename "$f")
    if ! has_ref "$base"; then
      unrun_shell+=("scripts/__tests__/$base")
    elif ! has_pr_ref "$base"; then
      unreachable_shell+=("scripts/__tests__/$base")
    fi
  done < <(find "$ROOT/scripts/__tests__" -maxdepth 1 -type f -name 'test-*.sh' | sort)
fi

# Finding nothing is not a pass. An empty result and a broken scan look identical from the
# outside, and this guard exists precisely to stop silent zeroes.
if [ "$found" -eq 0 ]; then
  echo "ERROR: no test files found under $ROOT/scripts/__tests__ - the scan is broken, not the tree clean"
  exit 1
fi

status=0

if [ ${#unrun_shell[@]} -gt 0 ]; then
  echo "Shell suites that no workflow runs:"
  for f in "${unrun_shell[@]}"; do echo "  - $f"; done
  echo "  These pass locally and gate nothing. Fix: add a 'run: bash <path>' step to the"
  echo "  'test' job in .github/workflows/ci.yml, next to the other guard steps."
  status=1
fi

# Deliberately a separate message. The two failures need opposite fixes, and telling someone
# who already wrote a run: line to add one sends them looking in the wrong place.
if [ ${#unreachable_shell[@]} -gt 0 ]; then
  echo "Shell suites with a runner, but not on a pull request:"
  for f in "${unreachable_shell[@]}"; do echo "  - $f"; done
  echo "  Something runs these, and nothing runs them before a merge - either the workflow has"
  echo "  no pull_request trigger, or the job carries an if: that skips pull requests. Fix: run"
  echo "  it from the 'test' job in .github/workflows/ci.yml as well."
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "check-test-runners: $found shell suite(s), every one has a runner a pull request reaches."
fi

exit "$status"
