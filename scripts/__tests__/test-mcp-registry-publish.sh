#!/usr/bin/env bash
# Guards for scripts/mcp-registry-publish.sh (ALI-1670): the promotion's registry publish must pass
# when the registry already holds this exact version, and must still fail on a real collision or a
# genuine publish failure.
#
# The subject runs against a stub curl and a stub publisher. Each stub leaves a sentinel, so every
# case asserts that the thing it expects to have run DID run (the publisher's call count), not only
# an exit code: "exit 0" alone is also what a script that never reached the publish step prints.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/mcp-registry-publish.sh"
[ -f "$SUT" ] || { echo "FATAL: $SUT is missing"; exit 1; }
command -v node >/dev/null || { echo "FATAL: node is required"; exit 1; }

FAILURES=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/server.json" <<'JSON'
{"name":"io.github.example/cli","version":"1.2.3","packages":[{"registryType":"npm","identifier":"@example/cli","version":"1.2.3","transport":{"type":"stdio"}}]}
JSON

# The registry's answer shape: { server: {...}, _meta: {...} }.
registry_body() { # $1 = version, $2 = package version
  printf '{"server":{"name":"io.github.example/cli","version":"%s","packages":[{"registryType":"npm","identifier":"@example/cli","version":"%s"}]},"_meta":{}}' "$1" "$2"
}

# Stub curl: replies come from $TMP/replies, one "<code> <bodyfile-or-dash>" line per call, the last
# line repeating once the list is exhausted. It honours -o and -w '%{http_code}' like the real one.
cat > "$TMP/curl" <<'STUB'
#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
n=$(cat "$STUB_DIR/curl.n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_DIR/curl.n"
line=$(sed -n "${n}p" "$STUB_DIR/replies"); [ -n "$line" ] || line=$(tail -n 1 "$STUB_DIR/replies")
code=${line%% *}; file=${line#* }
if [ "$code" = "000" ]; then exit 7; fi
if [ "$file" != "-" ] && [ -n "$out" ]; then cat "$file" > "$out"; elif [ -n "$out" ]; then : > "$out"; fi
printf '%s' "$code"
STUB
cat > "$TMP/publisher" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$STUB_DIR/pub.n" 2>/dev/null || echo 0); echo $((n+1)) > "$STUB_DIR/pub.n"
exit "${STUB_PUBLISH_RC:-0}"
STUB
chmod +x "$TMP/curl" "$TMP/publisher"

same="$TMP/same.json";   registry_body 1.2.3 1.2.3 > "$same"
diff_="$TMP/diff.json";  registry_body 1.2.3 9.9.9 > "$diff_"

# run_case <replies...> ; env STUB_PUBLISH_RC is read from the caller. Sets $rc, $out, $pubcalls.
run_case() {
  rm -f "$TMP/curl.n" "$TMP/pub.n"; : > "$TMP/replies"
  for r in "$@"; do echo "$r" >> "$TMP/replies"; done
  out="$(STUB_DIR="$TMP" MCP_PUBLISHER="$TMP/publisher" MCP_REGISTRY_CURL="$TMP/curl" RETRY_SLEEP=0 bash "$SUT" "$TMP/server.json" 2>&1)"; rc=$?
  pubcalls="$(cat "$TMP/pub.n" 2>/dev/null || echo 0)"
}

# T1: version absent -> published once
STUB_PUBLISH_RC=0 run_case "404 -"
{ [ "$rc" -eq 0 ] && [ "$pubcalls" -eq 1 ]; } && ok "absent version is published once" || bad "absent: rc=$rc pubcalls=$pubcalls out=$out"

# T2: registry already has the same content -> success, publisher never runs
STUB_PUBLISH_RC=1 run_case "200 $same"
{ [ "$rc" -eq 0 ] && [ "$pubcalls" -eq 0 ] && printf '%s' "$out" | grep -q "already has"; } && ok "already-published exact version passes without publishing" || bad "same: rc=$rc pubcalls=$pubcalls out=$out"

# T3: registry holds the version with different content -> real collision, fails, publisher never runs
STUB_PUBLISH_RC=0 run_case "200 $diff_"
{ [ "$rc" -eq 1 ] && [ "$pubcalls" -eq 0 ] && printf '%s' "$out" | grep -q "DIFFERENT"; } && ok "a version held with different content fails" || bad "different: rc=$rc pubcalls=$pubcalls out=$out"

# T4: registry unreachable (5xx and a curl failure) is not read as absent-and-published-elsewhere,
# but the publish is still attempted, and its own result decides
STUB_PUBLISH_RC=0 run_case "503 -"
{ [ "$rc" -eq 0 ] && [ "$pubcalls" -eq 1 ]; } && ok "an unreadable registry falls through to a real publish (5xx)" || bad "5xx: rc=$rc pubcalls=$pubcalls out=$out"
STUB_PUBLISH_RC=0 run_case "000 -"
{ [ "$rc" -eq 0 ] && [ "$pubcalls" -eq 1 ]; } && ok "an unreadable registry falls through to a real publish (curl failure)" || bad "curl fail: rc=$rc pubcalls=$pubcalls out=$out"

# T5: publish fails, but a parallel run published meanwhile (registry now says same) -> success
STUB_PUBLISH_RC=1 run_case "404 -" "200 $same"
{ [ "$rc" -eq 0 ] && [ "$pubcalls" -eq 1 ] && printf '%s' "$out" | grep -q "parallel run"; } && ok "a lost race to a parallel publish passes" || bad "race: rc=$rc pubcalls=$pubcalls out=$out"

# T6: publish keeps failing and the registry never gets the version -> fails after three attempts
STUB_PUBLISH_RC=1 run_case "404 -"
{ [ "$rc" -eq 1 ] && [ "$pubcalls" -eq 3 ]; } && ok "a genuine publish failure still fails after 3 attempts" || bad "genuine failure: rc=$rc pubcalls=$pubcalls out=$out"

# T7: a missing server.json is a usage error, not a pass
out="$(MCP_PUBLISHER="$TMP/publisher" bash "$SUT" "$TMP/nope.json" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && ok "a missing server.json exits 2" || bad "missing file: rc=$rc out=$out"

[ "$FAILURES" -eq 0 ] && echo "All passed" || { echo "$FAILURES failed"; exit 1; }
