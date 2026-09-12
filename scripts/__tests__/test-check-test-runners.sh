#!/usr/bin/env bash
# Guards for scripts/check-test-runners.sh, which fails when a shell suite in
# scripts/__tests__/ is invoked by no workflow step that a pull request can reach.
#
# The guard's failure mode is silence in both directions, so most of these tests are about
# telling "nothing to report" apart from "the scan found nothing". An unrun test produces no
# output, and neither does a guard that cannot see any files - which is why the first test
# below runs against the REAL repo and asserts a non-zero file count.
#
# The second half of the file covers PR-reachability (ALI-727). A `run:` line that exists but
# cannot execute on a pull request gates nothing, and it is indistinguishable from a working
# one by eye: the difference lives in the workflow's `on:` block, or in a job-level `if:`
# fifty lines above the step.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$SCRIPT_DIR/check-test-runners.sh"
FAILURES=0

[ -f "$GUARD" ] || { echo "FATAL: $GUARD is missing"; exit 1; }

ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# Builds a throwaway repo: <dir>/scripts/__tests__/<suite files> and one workflow.
make_fixture() { # <workflow-yaml-content> <suite-name...>
  local wf="$1"; shift
  local d; d="$(mktemp -d)"
  mkdir -p "$d/scripts/__tests__" "$d/.github/workflows"
  for s in "$@"; do printf '#!/usr/bin/env bash\nexit 0\n' > "$d/scripts/__tests__/$s"; done
  printf '%s\n' "$wf" > "$d/.github/workflows/ci.yml"
  printf '%s' "$d"
}

# A second workflow in the same fixture, for the cases where the question is WHICH workflow
# carries the runner.
add_workflow() { # <dir> <filename> <yaml>
  printf '%s\n' "$3" > "$1/.github/workflows/$2"
}

# --- the positive control, and it is the only test that can catch one whole bug class -----
#
# align-stack's copy of this guard shipped with `printf ... | grep -q` inside it, which is
# inverted under `set -o pipefail`: grep exits on first match, printf takes SIGPIPE, and the
# pipeline reports failure, so EVERY suite reads as unrun. Fixtures never trigger it - printf
# finishes before grep can exit - so the unit suite was green while the guard was broken on
# the real tree. Only a run against a real repo with real workflow files can see it.
OUT="$(bash "$GUARD" "$REPO_ROOT" 2>&1)"; rc=$?
COUNT="$(printf '%s' "$OUT" | grep -oE '[0-9]+ shell suite' | grep -oE '^[0-9]+' | head -1)"
if [ "$rc" -eq 0 ] && [ -n "$COUNT" ] && [ "$COUNT" -ge 2 ]; then
  ok "clean on this repo, and reports $COUNT test files (a real scan, not an empty one)"
else
  bad "on the real repo: rc=$rc count='${COUNT:-none}' out: $OUT"
fi

# --- an orphan must be named ---------------------------------------------------------------
D="$(make_fixture 'on:
  pull_request:
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-wired.sh' test-wired.sh test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'test-orphan.sh'; then
  ok "fails and names a suite no workflow runs"
else
  bad "an orphan suite passed (rc=$rc): $OUT"
fi
# ...and must not drag its wired sibling in with it.
if printf '%s' "$OUT" | grep -q 'test-wired.sh'; then
  bad "reported the wired sibling as unrun too"
else
  ok "does not report the wired sibling"
fi
rm -rf "$D"

# --- a wired suite must pass ---------------------------------------------------------------
D="$(make_fixture 'on:
  pull_request:
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-wired.sh' test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "passes when every suite has a run: step"; else bad "wired suite failed (rc=$rc): $OUT"; fi
rm -rf "$D"

# --- the discriminating case: a mention that EXECUTES NOTHING ------------------------------
#
# This is the bug a review caught on align-stack#1444. A filename appears in workflow YAML in
# several places that run nothing - a `paths:` trigger filter, a step `name:`, an `if:`. A
# whole-file grep credits all of them, so the guard would vouch for a suite that is never
# invoked: reading the identifier instead of what executes.
D="$(make_fixture 'on:
  pull_request:
    paths:
      - scripts/__tests__/test-orphan.sh
jobs:
  test:
    steps:
      - name: Run scripts/__tests__/test-orphan.sh
        if: contains(github.event.head_commit.message, "scripts/__tests__/test-orphan.sh")
        run: echo skipped' test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'test-orphan.sh'; then
  ok "a paths:/name:/if: mention is not a runner"
else
  bad "credited a mention that executes nothing (rc=$rc): $OUT"
fi
rm -rf "$D"

# --- block scalars are real runners --------------------------------------------------------
D="$(make_fixture 'on:
  pull_request:
jobs:
  test:
    steps:
      - run: |
          echo hello
          bash scripts/__tests__/test-wired.sh' test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "reads a run: | block scalar's continuation lines"; else bad "missed a block-scalar runner (rc=$rc): $OUT"; fi
rm -rf "$D"

# The other half of that: a sibling key sits at the SAME indent as `run:` and ends the block.
# Crediting it would make an env var holding a path look like an invocation.
D="$(make_fixture 'on:
  pull_request:
jobs:
  test:
    steps:
      - run: |
          echo hello
        env:
          SUITE: scripts/__tests__/test-orphan.sh' test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'test-orphan.sh'; then
  ok "a sibling env: at the run: indent does not extend the block"
else
  bad "swept a sibling env: into the run block (rc=$rc): $OUT"
fi
rm -rf "$D"

# --- an empty scan is a broken guard, not a clean tree -------------------------------------
D="$(make_fixture 'on:
  pull_request:
jobs:
  test:
    steps:
      - run: echo nothing')"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'scan is broken'; then
  ok "finding no test files fails loudly rather than reporting a clean pass"
else
  bad "an empty scan reported success (rc=$rc): $OUT"
fi
rm -rf "$D"

# A repo with no workflows at all must not silently pass either: every suite is unrun there.
D="$(make_fixture 'jobs: {}' test-orphan.sh)"
rm -rf "$D/.github"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "no workflows at all means every suite is unrun"; else bad "passed with no workflows present: $OUT"; fi
rm -rf "$D"

# ============================================================================================
# PR-reachability (ALI-727). A runner that exists is not yet a runner that gates a merge.
# ============================================================================================

# --- a workflow that never triggers on a pull request is not a gate ------------------------
#
# The live instance: three of align-cli's four workflows (e2e-release, promote-release,
# release-please) trigger on release / workflow_dispatch / workflow_run / push-to-main. A
# suite wired only into one of those runs, passes, and reports - after the merge it was
# supposed to block.
D="$(make_fixture 'on:
  release:
    types: [published]
jobs:
  e2e:
    steps:
      - run: bash scripts/__tests__/test-orphan.sh' test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'test-orphan.sh'; then
  ok "a runner in a workflow with no pull_request trigger does not count"
else
  bad "credited a runner that a pull request never reaches (rc=$rc): $OUT"
fi
# The two failures need different fixes, so they must not share a message. "Add a run: step"
# is wrong advice for a suite that already has one.
if printf '%s' "$OUT" | grep -qi 'not on a pull request'; then
  ok "says the runner exists but no pull request reaches it"
else
  bad "reported it as having no runner at all, which is the wrong fix: $OUT"
fi
rm -rf "$D"

# --- ...but a suite wired in BOTH places is fine -------------------------------------------
# Over-eagerness here would be its own defect: the release workflow running a suite as well
# is a good thing, not a violation.
D="$(make_fixture 'on:
  release:
    types: [published]
jobs:
  e2e:
    steps:
      - run: bash scripts/__tests__/test-wired.sh' test-wired.sh)"
add_workflow "$D" 'pr.yml' 'on:
  pull_request:
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-wired.sh'
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a suite run by both a release workflow and a PR workflow passes"
else
  bad "flagged a suite that a pull request does reach (rc=$rc): $OUT"
fi
rm -rf "$D"

# --- the flow-style trigger is still a pull_request trigger --------------------------------
D="$(make_fixture 'on: [push, pull_request]
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-wired.sh' test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "reads on: [push, pull_request] as PR-triggering"; else bad "missed a flow-style trigger (rc=$rc): $OUT"; fi
rm -rf "$D"

# --- a job the pull request skips is not a gate either -------------------------------------
#
# The live instance: ci.yml's cross-platform job carries
# `if: github.event_name != 'pull_request'`, so it runs on push-to-main only. The workflow
# triggers on pull_request, the step is a real run: line, and the suite still never executes
# before a merge. The exclusion sits at the top of the job, far from the step.
D="$(make_fixture "on:
  pull_request:
jobs:
  cross-platform:
    if: github.event_name != 'pull_request'
    steps:
      - run: bash scripts/__tests__/test-orphan.sh" test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'test-orphan.sh'; then
  ok "a job-level if: excluding pull_request does not count as a runner"
else
  bad "credited a runner inside a job a pull request skips (rc=$rc): $OUT"
fi
rm -rf "$D"

# --- ...and the exclusion must stop at the job it is written on -----------------------------
#
# The negative control for the case above. Attribute the if: to the whole FILE rather than to
# its job and every sibling job in ci.yml stops counting, which would fail the real repo -
# loudly, but for a reason that has nothing to do with the tree.
D="$(make_fixture "on:
  pull_request:
jobs:
  cross-platform:
    if: github.event_name != 'pull_request'
    steps:
      - run: echo not on PRs
  test:
    steps:
      - run: bash scripts/__tests__/test-wired.sh" test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a sibling job's if: does not disqualify the job that carries the runner"
else
  bad "let one job's if: leak onto the next job (rc=$rc): $OUT"
fi
rm -rf "$D"

# --- a STEP-level if: is not a job-level one ------------------------------------------------
# Step-level conditions are ordinary and mostly unrelated to events; treating one as a job
# exclusion would flag working wiring. The guard reads only the job's own `if:`.
D="$(make_fixture "on:
  pull_request:
jobs:
  test:
    steps:
      - name: something else
        if: github.event_name != 'pull_request'
        run: echo unrelated
      - run: bash scripts/__tests__/test-wired.sh" test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a step-level if: on a different step is not a job exclusion"
else
  bad "read a step-level if: as excluding the whole job (rc=$rc): $OUT"
fi
rm -rf "$D"


# ============================================================================================
# Regressions from the review on #290. Every one of these was a FALSE RESULT from scanning
# YAML line by line, which is why the scanner was replaced with a real parse: a line scanner
# cannot see nesting, and all five findings are that one fact wearing five costumes
# (verification.md, "a parser beats a regex the moment nesting is involved").
# ============================================================================================

# --- 1. a single-quoted `on:` key is still an on: key ---------------------------------------
# Valid YAML, and the old scanner matched only bare and double-quoted spellings, so it read
# this workflow as having no PR trigger. FALSE FAILURE on correctly wired CI.
D="$(make_fixture "'on': pull_request
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-wired.sh" test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "a single-quoted 'on': key is read as a trigger"; else bad "false failure on 'on': (rc=$rc): $OUT"; fi
rm -rf "$D"

# --- 2. only the DIRECT children of on: are events ------------------------------------------
# The dangerous direction. `pull_request` appearing as a branch name, a path filter or any
# other nested value is not a trigger, and crediting it lets a runner in a push-only workflow
# pass - the exact false green this guard exists to prevent.
D="$(make_fixture 'on:
  push:
    branches:
      - pull_request
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-orphan.sh' test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'test-orphan.sh'; then
  ok "a branch named pull_request is not a pull_request trigger"
else
  bad "nested value read as an event, runner credited (rc=$rc): $OUT"
fi
rm -rf "$D"

# ...and the flow-mapping spelling of the same trap.
D="$(make_fixture 'on: { push: { branches: [pull_request] } }
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-orphan.sh' test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "flow-mapping on: with a nested pull_request value is not a trigger"; else bad "flow-mapping nesting credited (rc=$rc): $OUT"; fi
rm -rf "$D"

# --- 3. the job condition is an EXPRESSION, not one hardcoded shape -------------------------
# `== 'push'` excludes pull requests just as surely as `!= 'pull_request'` does.
D="$(make_fixture "on:
  pull_request:
jobs:
  test:
    if: github.event_name == 'push'
    steps:
      - run: bash scripts/__tests__/test-orphan.sh" test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "if: event_name == 'push' excludes pull requests"; else bad "only the != shape was recognised (rc=$rc): $OUT"; fi
rm -rf "$D"

# A mapping is unordered, so an if: written AFTER steps: governs the job just the same. The
# line scanner only saw conditions that preceded the run: line.
D="$(make_fixture "on:
  pull_request:
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-orphan.sh
    if: github.event_name != 'pull_request'" test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "a job if: written after steps: still governs the job"; else bad "if: after steps: was ignored (rc=$rc): $OUT"; fi
rm -rf "$D"

# The other direction, and the one a substring match gets backwards: excluding
# pull_request_target says nothing about pull_request. Treating it as an exclusion is a false
# failure on wiring that is completely correct.
D="$(make_fixture "on:
  pull_request:
jobs:
  test:
    if: github.event_name != 'pull_request_target'
    steps:
      - run: bash scripts/__tests__/test-wired.sh" test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "!= 'pull_request_target' does not exclude pull_request"; else bad "substring-matched the wrong event (rc=$rc): $OUT"; fi
rm -rf "$D"

# ...and a disjunction that readmits pull requests must stay reachable.
D="$(make_fixture "on:
  pull_request:
jobs:
  test:
    if: \${{ github.event_name == 'push' || github.event_name == 'pull_request' }}
    steps:
      - run: bash scripts/__tests__/test-wired.sh" test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "a || that readmits pull_request stays reachable"; else bad "read a disjunction as an exclusion (rc=$rc): $OUT"; fi
rm -rf "$D"

# --- 4. the condition on the RUNNER'S OWN step --------------------------------------------
# The existing control covers an if: on a DIFFERENT step, which sits on the wrong side of the
# boundary: it can pass while the same-step case is unhandled (tdd.md, "a fixture that never
# reaches the branch it is testing"). This is that case.
D="$(make_fixture "on:
  pull_request:
jobs:
  test:
    steps:
      - if: github.event_name != 'pull_request'
        run: bash scripts/__tests__/test-orphan.sh" test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "a step-level if: on the runner's own step excludes it"; else bad "same-step if: ignored (rc=$rc): $OUT"; fi
rm -rf "$D"

# ...while a sibling step that IS reachable still counts. Excluding the whole job would be the
# over-correction.
D="$(make_fixture "on:
  pull_request:
jobs:
  test:
    steps:
      - if: github.event_name != 'pull_request'
        run: echo push only
      - run: bash scripts/__tests__/test-wired.sh" test-wired.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "one excluded step does not disqualify its reachable sibling"; else bad "a step's if: leaked onto the whole job (rc=$rc): $OUT"; fi
rm -rf "$D"

# --- 5. `run` must be a STEP's key, not any key spelled run ---------------------------------
# `with: { run: ... }` is input data to an action. Nothing executes it.
D="$(make_fixture 'on:
  pull_request:
jobs:
  test:
    steps:
      - uses: some/action@v1
        with:
          run: bash scripts/__tests__/test-orphan.sh' test-orphan.sh)"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'test-orphan.sh'; then
  ok "a run: nested under with: is data, not a runner"
else
  bad "credited a with: input as a shell step (rc=$rc): $OUT"
fi
rm -rf "$D"

# --- the parse must fail loudly, never quietly find nothing ---------------------------------
# A workflow that does not parse makes every suite read as unrun. That is a red either way,
# but the message has to name the file, or the next person debugs the wrong thing.
D="$(make_fixture 'on:
  pull_request:
jobs:
  test:
    steps:
      - run: bash scripts/__tests__/test-wired.sh' test-wired.sh)"
printf 'this: is: not: valid: yaml:\n  - [unclosed\n' > "$D/.github/workflows/broken.yml"
OUT="$(bash "$GUARD" "$D" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT" | grep -q 'broken.yml'; then
  ok "an unparseable workflow fails loudly and names the file"
else
  bad "a broken workflow did not name itself (rc=$rc): $OUT"
fi
rm -rf "$D"

# --- a guard that cannot run must not report a clean tree ----------------------------------
# The parse lives in a helper that needs node and js-yaml. If either is unavailable the guard
# has to fail, not return an empty parse - an empty parse makes every suite look unrun, and the
# reverse mistake (returning success) would make this gate vouch for a tree it never read.
# Verified here by running a copy of the guard from a directory with no helper beside it.
D="$(mktemp -d)"
cp "$GUARD" "$D/check-test-runners.sh"
mkdir -p "$D/scripts/__tests__" "$D/.github/workflows"
printf '#!/usr/bin/env bash\nexit 0\n' > "$D/scripts/__tests__/test-wired.sh"
printf 'on:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: bash scripts/__tests__/test-wired.sh\n' > "$D/.github/workflows/ci.yml"
OUT="$(bash "$D/check-test-runners.sh" "$D" 2>&1)"; rc=$?
# Assert the GUARD's own message, not merely a non-zero exit. Node also fails on a missing
# module and its error names the path too, so a looser assertion passes whether or not the
# guard checks anything - a test satisfied by a different mechanism than the one it names
# (mutation-testing.md). Only "ERROR: ... is missing" distinguishes them.
if [ "$rc" -ne 0 ] \
   && printf '%s' "$OUT" | grep -q 'workflow-run-steps.mjs' \
   && printf '%s' "$OUT" | grep -q 'is missing'; then
  ok "with no parser helper beside it, the guard fails and names what is missing"
else
  bad "a guard that could not parse anything reported a verdict (rc=$rc): $OUT"
fi
rm -rf "$D"
echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "CHECK-TEST-RUNNERS GUARDS: $FAILURES failed"
  exit 1
fi
echo "CHECK-TEST-RUNNERS GUARDS: all passed"
