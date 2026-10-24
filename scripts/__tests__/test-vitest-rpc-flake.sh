#!/usr/bin/env bash
# Guards for scripts/vitest-rpc-flake.sh, which decides whether a failed `npm test` on the Windows
# leg failed ONLY because vitest's worker gave up waiting for the main process.
#
# The fixtures are the summary block of a real Windows run on main (all 7674 tests passed, exit 1
# from one "Timeout calling onTaskUpdate"), with the ANSI colour codes vitest prints in CI. Every
# other case is that block with one thing changed, so a "no" can only come from the thing changed.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/vitest-rpc-flake.sh"
FAILURES=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$SUT" ] || { echo "FATAL: $SUT is missing"; exit 1; }

ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

E=$'\x1b'
RPC="Error: [vitest-worker]: Timeout calling \"onTaskUpdate\""
summary() { # $1 test files line, $2 tests line, $3 errors line
  printf '%s\n' \
    "${E}[31m⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯${E}[39m" \
    "${E}[31m${E}[1mError${E}[22m: [vitest-worker]: Timeout calling \"onTaskUpdate\"${E}[39m" \
    " ${E}[36m❯${E}[39m Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10" \
    "" \
    "$1" "$2" "$3"
}
FILES_OK="${E}[2m Test Files ${E}[22m ${E}[1m${E}[32m500 passed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[33m8 skipped${E}[39m${E}[90m (508)${E}[39m"
TESTS_OK="${E}[2m      Tests ${E}[22m ${E}[1m${E}[32m7674 passed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[33m173 skipped${E}[39m${E}[90m (7847)${E}[39m"
ERRS_ONE="${E}[2m     Errors ${E}[22m ${E}[1m${E}[31m1 error${E}[39m${E}[22m"

check() { # $1 expected rc, $2 label, $3 log body
  printf '%s' "$3" > "$TMP/log"
  out=$(bash "$SUT" "$TMP/log" 2>&1); rc=$?
  if [ "$rc" -eq "$1" ]; then ok "$2"; else bad "$2 (expected rc=$1, got rc=$rc): $out"; fi
}

# The positive control: the real run. Without it every "no" below could be a script that says no to everything.
check 0 "the real Windows run (all tests passed, one onTaskUpdate timeout) is the flake" \
  "$(summary "$FILES_OK" "$TESTS_OK" "$ERRS_ONE")"

# The Windows runner's log really ends each line in CRLF. The first version of the script passed every
# LF fixture here and said no to the real log.
check 0 "the same run with the CRLF line endings the Windows log really has is the flake" \
  "$(summary "$FILES_OK" "$TESTS_OK" "$ERRS_ONE" | sed $'s/$/\r/')"

check 1 "a failed test alongside the timeout is a real failure" \
  "$(summary "$FILES_OK" "${E}[2m      Tests ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m7673 passed${E}[39m${E}[22m (7847)" "$ERRS_ONE")"

check 1 "a test file that failed to load is a real failure, even with every collected test passing" \
  "$(summary "${E}[2m Test Files ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m499 passed${E}[39m (508)" "$TESTS_OK" "$ERRS_ONE")"

check 1 "a second unhandled error is a real failure" \
  "$(summary "$FILES_OK" "$TESTS_OK" "${E}[2m     Errors ${E}[22m ${E}[1m${E}[31m2 errors${E}[39m${E}[22m")"

check 1 "one unhandled error that is NOT the onTaskUpdate timeout is a real failure" \
  "$(summary "$FILES_OK" "$TESTS_OK" "$ERRS_ONE" | sed 's/Timeout calling "onTaskUpdate"/Cannot read properties of undefined/')"

check 1 "the timeout text with no summary (the run died before reporting) is a real failure" \
  "$(printf '%s\n' "$RPC")"

check 1 "a log with no errors at all has nothing to retry" \
  "$(printf '%s\n' "$FILES_OK" "$TESTS_OK")"

out=$(bash "$SUT" "$TMP/does-not-exist" 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "does-not-exist"; then
  ok "a missing log is an error naming the path, never a yes"
else
  bad "a missing log returned rc=$rc: $out"
fi

echo
if [ "$FAILURES" -gt 0 ]; then echo "$FAILURES failed"; exit 1; fi
echo "all passed"
