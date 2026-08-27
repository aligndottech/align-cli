#!/usr/bin/env bash
# Guards for scripts/check-test-runners.sh, which fails when a shell suite in
# scripts/__tests__/ is invoked by no workflow.
#
# The guard's failure mode is silence in both directions, so most of these tests are about
# telling "nothing to report" apart from "the scan found nothing". An unrun test produces no
# output, and neither does a guard that cannot see any files - which is why the first test
# below runs against the REAL repo and asserts a non-zero file count.
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
D="$(make_fixture 'jobs:
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
D="$(make_fixture 'jobs:
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
D="$(make_fixture 'jobs:
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
D="$(make_fixture 'jobs:
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
D="$(make_fixture 'jobs:
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

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "CHECK-TEST-RUNNERS GUARDS: $FAILURES failed"
  exit 1
fi
echo "CHECK-TEST-RUNNERS GUARDS: all passed"
