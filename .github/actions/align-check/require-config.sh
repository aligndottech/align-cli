#!/usr/bin/env bash
# Refuse to run a check that has no credentials.
#
# Why this exists: with `token` empty (repository secret ALIGN_TOKEN not set) the CLI answers
# "Align is not set up on this machine" (status error, exit 2). decide.sh treats that like any
# incomplete check, and under the default fail-on=conflict an incomplete check passes. So a
# missing or expired secret turned a required check green on every PR, with nothing verified.
# NOT CONFIGURED is not transient: re-running never fixes it, so it must not take the
# transient-outage path.
#
# Usage: require-config.sh <token> <gateway-url> [allow-unconfigured]
#   gateway-url set  -> a self-hosted or local gateway may not authenticate, so no token is fine.
#   allow-unconfigured: "true" downgrades the failure to a warning. Anything else is false.
# Prints a workflow command. Exits 0 to continue, 1 to fail the job.
set -uo pipefail

TOKEN="${1:-}"
GATEWAY_URL="${2:-}"
ALLOW="${3:-false}"

# Trim whitespace: a secret pasted with a trailing newline, or only spaces, is still empty.
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
GATEWAY_URL="$(printf '%s' "$GATEWAY_URL" | tr -d '[:space:]')"

if [ -n "$TOKEN" ] || [ -n "$GATEWAY_URL" ]; then
  exit 0
fi

MSG="ALIGN_TOKEN is empty: set the repository secret ALIGN_TOKEN and pass it as the 'token' input (or set 'gateway-url' for a gateway that does not authenticate). Nothing was checked."

if [ "$ALLOW" = "true" ]; then
  echo "::warning::$MSG (allow-unconfigured is true, so this job passes without verifying anything.)"
  exit 0
fi

echo "::error::$MSG"
exit 1
