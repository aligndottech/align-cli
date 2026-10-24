#!/usr/bin/env bash
# Publish server.json to the MCP registry, idempotently.
#
# promote-release.yml can run twice for one release: once from a manual dispatch and once from the
# workflow_run that fires when the e2e gate goes green. The second run's publish used to fail with
# "cannot publish duplicate version" and turn the whole promotion red although nothing was wrong,
# which teaches people to ignore red on this workflow.
#
# So: ask the registry first. If it already holds this exact version (server version and every npm
# package version equal to server.json's), say so and succeed. If it holds the version with
# DIFFERENT content, that is a real collision and this fails. If the version is absent, publish with
# the same retry as before, and re-ask after a failed attempt in case a parallel run won the race.
#
# Usage: mcp-registry-publish.sh <server.json>
# Env (all optional, for tests): MCP_PUBLISHER (default ./mcp-publisher), MCP_REGISTRY_CURL
# (default curl), MCP_REGISTRY_BASE, RETRY_SLEEP (default 30).
set -u

SERVER_JSON="${1:-}"
[ -f "$SERVER_JSON" ] || { echo "FATAL: usage: $0 <server.json> (got '${SERVER_JSON}')"; exit 2; }

PUBLISHER="${MCP_PUBLISHER:-./mcp-publisher}"
CURL="${MCP_REGISTRY_CURL:-curl}"
BASE="${MCP_REGISTRY_BASE:-https://registry.modelcontextprotocol.io}"
SLEEP="${RETRY_SLEEP:-30}"

NAME="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "$SERVER_JSON")" || exit 2
VERSION="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$SERVER_JSON")" || exit 2
[ -n "$NAME" ] && [ -n "$VERSION" ] || { echo "FATAL: server.json has no name or version"; exit 2; }
ENC_NAME="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$NAME")"

# Prints one of: absent | same | different. Anything else (a network error, a 5xx) is "unknown",
# which is never read as absent: "I could not look" must not become "publish and see".
registry_state() {
  local body code
  body="$(mktemp)"
  code="$($CURL -sS -o "$body" -w '%{http_code}' "$BASE/v0/servers/$ENC_NAME/versions/$VERSION")" || { rm -f "$body"; echo unknown; return; }
  case "$code" in
    404) echo absent ;;
    200)
      node -e '
        const fs = require("fs");
        const mine = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const theirs = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).server;
        const pv = (s) => JSON.stringify((s.packages || []).map((p) => [p.registryType, p.identifier, p.version]));
        process.stdout.write(theirs && theirs.version === mine.version && pv(theirs) === pv(mine) ? "same" : "different");
      ' "$SERVER_JSON" "$body" || echo unknown ;;
    *) echo unknown ;;
  esac
  rm -f "$body"
}

state="$(registry_state)"
case "$state" in
  same) echo "MCP registry already has $NAME $VERSION with this content: nothing to publish."; exit 0 ;;
  different) echo "FATAL: the MCP registry already holds $NAME $VERSION with DIFFERENT content. A published version cannot be replaced."; exit 1 ;;
  absent|unknown) : ;;
esac

n=0
until "$PUBLISHER" publish; do
  # A parallel promotion may have published between our check and our attempt.
  if [ "$(registry_state)" = "same" ]; then
    echo "MCP registry now has $NAME $VERSION (published by a parallel run): treating as done."
    exit 0
  fi
  n=$((n+1))
  [ "$n" -ge 3 ] && { echo "registry publish failed after $n attempts"; exit 1; }
  sleep "$SLEEP"
done
