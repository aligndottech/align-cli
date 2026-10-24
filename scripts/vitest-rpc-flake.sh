#!/usr/bin/env bash
# Exit 0 when a failed vitest run failed ONLY because a worker timed out calling "onTaskUpdate",
# so CI may run the suite once more. Exit 1 for any other failure, 2 when the log is unreadable.
#
# vitest 3's worker waits a fixed 60 s for the main process to acknowledge a progress report, and
# turns the wait into an unhandled error that fails the run. Nothing in vitest.config.ts can raise
# it. The Windows runner stalls past it now and then with every test passing (7674 passed, exit 1).
#
# "Only" is checked from the summary vitest prints, never from the error text alone: a run that
# died before its summary, a failed test, a file that failed to load, or any second error is a
# real failure and must stay one.
#
# Usage: scripts/vitest-rpc-flake.sh <vitest-output-log>
set -u
LOG="${1:-}"
[ -n "$LOG" ] && [ -r "$LOG" ] || { echo "vitest-rpc-flake: cannot read the log '$LOG'" >&2; exit 2; }

# Colour codes and the CR of the Windows runner's CRLF lines both sit inside the lines matched below.
plain="$(sed $'s/\x1b\\[[0-9;]*m//g; s/\r$//' "$LOG")"
line() { printf '%s\n' "$plain" | grep -E "^ *$1 " | tail -1; }

files="$(line 'Test Files')"
tests="$(line 'Tests')"
errors="$(line 'Errors')"

[ -n "$files" ] && [ -n "$tests" ] || { echo "vitest-rpc-flake: no summary in the log, so the run did not finish"; exit 1; }
printf '%s\n' "$files$tests" | grep -q 'failed' && { echo "vitest-rpc-flake: tests or test files failed"; exit 1; }
printf '%s\n' "$errors" | grep -qE '^ *Errors +1 error$' || { echo "vitest-rpc-flake: not exactly one unhandled error ('${errors:-none}')"; exit 1; }
printf '%s\n' "$plain" | grep -qF 'Timeout calling "onTaskUpdate"' || { echo "vitest-rpc-flake: the one error is not the onTaskUpdate timeout"; exit 1; }

echo "vitest-rpc-flake: every test passed and the only error is the onTaskUpdate timeout"
