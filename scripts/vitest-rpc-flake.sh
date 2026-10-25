#!/usr/bin/env bash
# Exit 0 when a failed vitest run failed ONLY because a worker timed out calling "onTaskUpdate",
# so CI may run the suite once more. Exit 1 for any other failure, 2 when the log is unreadable.
#
# vitest 3's worker waits a fixed 60 s for the main process to acknowledge a progress report, and
# turns the wait into an unhandled error that fails the run. Nothing in vitest.config.ts can raise
# it. The Windows runner stalls past it now and then with every test passing (7674 passed, exit 1).
#
# "Only" is checked from the summary vitest prints, never from the error text alone: a run that
# died before its summary, a failed test, a file that failed to load, or any error that is not the
# timeout is a real failure and must stay one. Each worker can time out, so the summary may count
# several errors; every one of them must be the timeout.
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
n="$(printf '%s\n' "$errors" | sed -nE 's/^ *Errors +([1-9][0-9]*) errors?$/\1/p')"
[ -n "$n" ] || { echo "vitest-rpc-flake: no unhandled error count ('${errors:-none}')"; exit 1; }
timeouts="$(printf '%s\n' "$plain" | sed -n '/Unhandled Error/,$p' | grep -oF 'Timeout calling "onTaskUpdate"' | wc -l | tr -d ' ')"
[ "$timeouts" -eq "$n" ] || { echo "vitest-rpc-flake: $n unhandled errors but $timeouts are the onTaskUpdate timeout"; exit 1; }

echo "vitest-rpc-flake: every test passed and all $n unhandled errors are the onTaskUpdate timeout"
