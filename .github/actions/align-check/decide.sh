#!/usr/bin/env bash
# Decide whether an `align check --ci` result should fail the job.
#
# Extracted from action.yml so the policy is testable. Inline in a composite action it was
# only exercisable by pushing to a real repository, which is how it shipped with a defect:
# it classified on the EXIT CODE alone, and a CLI that crashes (an old version without
# --base, a bad flag, a runtime error) also exits 1 with no JSON on stdout. That was
# reported to the user as "found a conflict with a recorded decision" - "could not run"
# presented as "found something", the precise confusion the `unknown` status exists to stop.
#
# Usage: decide.sh <exit-code> <status> <fail-on>
#   status is parsed from the CLI's JSON; "error" when there was none to parse.
# Prints a one-line outcome. Exits 0 if the job should pass, 1 if it should fail.
set -uo pipefail

CODE="${1:-}"
STATUS="${2:-}"
FAIL_ON="${3:-conflict}"

if [ -z "$CODE" ] || [ -z "$STATUS" ]; then
  echo "decide.sh: usage: decide.sh <exit-code> <status> <fail-on>" >&2
  exit 2
fi

# A conflict is a POSITIVE finding, so it requires the CLI to have actually reported one.
# Exit code alone is not enough: 1 is also what a crash produces.
is_conflict() { [ "$CODE" = "1" ] && [ "$STATUS" = "conflicting" ]; }

# Everything else that is not a clean pass means the check did not complete. `unknown` is
# the CLI saying so deliberately (exit 2); `error`, or any other non-zero, is a crash.
is_incomplete() { ! is_conflict && { [ "$CODE" != "0" ] || [ "$STATUS" != "aligned" ]; }; }

case "$FAIL_ON" in
  never)
    echo "outcome=reported status=$STATUS code=$CODE (fail-on=never)"
    exit 0
    ;;
  conflict-or-unknown)
    if is_conflict; then
      echo "outcome=fail reason=conflict status=$STATUS code=$CODE"
      exit 1
    fi
    if is_incomplete; then
      echo "outcome=fail reason=incomplete status=$STATUS code=$CODE"
      exit 1
    fi
    echo "outcome=pass status=$STATUS code=$CODE"
    exit 0
    ;;
  conflict)
    if is_conflict; then
      echo "outcome=fail reason=conflict status=$STATUS code=$CODE"
      exit 1
    fi
    if is_incomplete; then
      # Deliberately not a failure: a required check that fails when the service is
      # unreachable turns an outage into a repo-wide merge freeze, which is the failure
      # mode this action exists to remove. Say plainly that nothing was verified.
      echo "outcome=pass reason=incomplete-not-enforced status=$STATUS code=$CODE"
      exit 0
    fi
    echo "outcome=pass status=$STATUS code=$CODE"
    exit 0
    ;;
  *)
    echo "decide.sh: unknown fail-on '$FAIL_ON' (use conflict, conflict-or-unknown or never)" >&2
    exit 2
    ;;
esac
