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
# check, and in this repo that gap is narrow but real: exactly one context is required, `test`,
# so a runner there gates a merge while one in cross-platform, binaries or install-smoke does
# not - and the last two DO run on pull requests, so the check below passes them. Re-derive
# rather than trusting that sentence; it is a setting, and settings move without a commit:
#
#   gh api repos/aligndottech/align-cli/branches/main/protection \
#     --jq .required_status_checks.contexts      # ["test"]
#
# Two traps in that one command, both of which gave the opposite answer here first. It is
# CLASSIC branch protection rather than a ruleset, so `gh api .../rules/branches/main` cannot
# see it and reports no status checks on a branch that has one. And the endpoint 404s for a
# token that does not collaborate on the repo, which reads exactly like "not configured"
# (verification.md, "a claim of ABSENCE needs a positive control").
#
# The required list is deliberately not hardcoded here: it would make this file a second writer
# of a fact that lives in branch protection (code-style.md).
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

# The run-step text comes from a real YAML PARSE, not a line scan of the workflow files.
#
# It used to be awk. A review of #290 found five separate false results in that scanner - three
# false greens and two false failures - and all five were one fact: YAML nests and a line
# scanner cannot see nesting. It read `branches: [pull_request]` as a trigger, `with: { run: }`
# as a shell step, an `if:` written after `steps:` as absent, and `!= \'pull_request_target\'` as
# excluding pull requests. The sixth patch would have left a seventh
# (verification.md, "a parser beats a regex the moment nesting is involved").
#
# The helper needs node and js-yaml. Both are guaranteed where this runs: js-yaml is a declared
# devDependency and `npm ci` is step 2 of the test job, while these guards are steps 9 and 10.
# If either is missing the helper exits non-zero and so does this, rather than reporting a clean
# tree from an empty parse.
GUARD_DIR="$(cd "$(dirname "$0")" && pwd)"
STEPS_MJS="$GUARD_DIR/workflow-run-steps.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to read the workflows and is not on PATH."
  exit 1
fi
[ -f "$STEPS_MJS" ] || { echo "ERROR: $STEPS_MJS is missing"; exit 1; }

WF_TEXT_ALL=$(node "$STEPS_MJS" "$ROOT" all) || exit 1
WF_TEXT_PR=$(node "$STEPS_MJS" "$ROOT" pr) || exit 1

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
  echo "  Something runs these, and nothing runs them before a merge. Either the workflow has no"
  echo "  pull_request trigger, or the job or the step carries an if: that a pull request fails -"
  echo "  an if: this guard cannot evaluate counts as unreachable too. Fix: run it from the"
  echo "  'test' job in .github/workflows/ci.yml, which is the only required status check."
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "check-test-runners: $found shell suite(s), every one has a runner a pull request reaches."
fi

exit "$status"
