#!/usr/bin/env bash
# Every shell suite in scripts/__tests__/ must have a workflow step that runs it.
#
# CI names each suite on its own `run:` line, so a new one is wired by hand and is trivially
# missed. When that happens the tests exist, pass locally, and gate nothing - and nothing goes
# red, because the absence of a runner has no output. The failure mode of an unrun test is
# silence, which is the whole reason this is a guard and not a convention.
#
# ALI-714. Both of this repo's suites were wired when it was written; nothing kept them that
# way. In align-stack the same gap let test-mutants.sh - 375 lines covering mutation-runner
# safety - sit green and unreferenced while its eight siblings ran (align-stack#1444).
#
# PORTED from align-stack's scripts/check-test-runners.sh, minus its helm-chart half, which
# this repo has no charts for. That makes two copies of one rule in two repos: if you fix a
# defect here, check the other one (code-style.md, "fixed one site, left the identical one").
# The two hard-won properties below came from that copy's review and are why this is a port
# rather than a rewrite.
#
# SCOPE, stated so it is not mistaken for more: this checks a runner EXISTS, not that the job
# carrying it is a required status check. A suite invoked only from an advisory workflow passes
# here and still blocks no merge.
#
# Usage: check-test-runners.sh [repo-root]
set -uo pipefail

ROOT="${1:-.}"

unrun_shell=()
found=0

# PROPERTY 1: only the text of `run:` steps counts as a runner.
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
workflow_run_text() {
  local dir="$ROOT/.github/workflows"
  [ -d "$dir" ] || return 0
  find "$dir" -type f \( -name '*.yaml' -o -name '*.yml' \) -exec awk '
      { sub(/#.*/, "", $0) }
      FNR==1 { inblock = 0 }
      {
        if (inblock) {
          if ($0 ~ /^[ \t]*$/) next
          match($0, /^[ ]*/)
          if (RLENGTH > runcol) { print; next }
          inblock = 0
        }
        if (match($0, /^[ ]*-?[ ]*run:[ ]*[|>]/)) {
          match($0, /run:/); runcol = RSTART - 1
          inblock = 1
          next
        }
        if ($0 ~ /^[ ]*-?[ ]*run:[ ]/) print
      }
    ' {} + 2>/dev/null
}

WF_TEXT=$(workflow_run_text)

# PROPERTY 2: match with a herestring, NOT `printf ... | grep -q`.
#
# That pipeline is wrong under `set -o pipefail`, and wrong only at scale: grep -q exits the
# instant it matches, printf takes SIGPIPE, and pipefail reports the pipeline as failed even
# though the match succeeded - so every suite reads as unrun. Small fixtures never trigger it,
# because printf finishes before grep can exit, which is how align-stack's copy shipped green
# unit tests over an inverted guard. The test suite's first case runs against this real repo
# for exactly that reason.
has_ref() { grep -qF -- "$1" <<<"$WF_TEXT"; }

if [ -d "$ROOT/scripts/__tests__" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    found=$((found + 1))
    base=$(basename "$f")
    has_ref "$base" || unrun_shell+=("scripts/__tests__/$base")
  done < <(find "$ROOT/scripts/__tests__" -maxdepth 1 -type f -name 'test-*.sh' | sort)
fi

# Finding nothing is not a pass. An empty result and a broken scan look identical from the
# outside, and this guard exists precisely to stop silent zeroes.
if [ "$found" -eq 0 ]; then
  echo "ERROR: no test files found under $ROOT/scripts/__tests__ - the scan is broken, not the tree clean"
  exit 1
fi

if [ ${#unrun_shell[@]} -gt 0 ]; then
  echo "Shell suites that no workflow runs:"
  for f in "${unrun_shell[@]}"; do echo "  - $f"; done
  echo "  These pass locally and gate nothing. Fix: add a 'run: bash <path>' step to the"
  echo "  'test' job in .github/workflows/ci.yml, next to the other guard steps."
  exit 1
fi

echo "check-test-runners: $found shell suite(s), every one has a runner."
