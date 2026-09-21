#!/usr/bin/env bash
# Guards for scripts/check-copilot-review-on-push.sh.
#
# The guard itself needs the network. These tests deliberately do NOT, because Repo Guards is
# bash-only and a guard's own proof must not depend on the thing it is checking being
# reachable. Every case drives a fixture through the parser.
#
# THE POSITIVE CONTROL IS THE LOAD-BEARING ONE. A guard that fails on everything passes every
# "it fails when X is wrong" case here, and would then break every PR in the repo. So the
# correct fixture must go GREEN, and that assertion is worth more than the rest combined.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check-copilot-review-on-push.sh"

[ -x "$GUARD" ] || { echo "FATAL: $GUARD is missing or not executable"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok: $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL: $1" >&2; }

# $1 label, $2 fixture contents, $3 expected exit (0 or 1), $4 substring expected in output
run_case() {
  local label="$1" body="$2" want="$3" want_msg="${4:-}"
  local f="$TMP/fixture.json"
  printf '%s' "$body" > "$f"
  local out rc
  out=$("$GUARD" "$f" 2>&1); rc=$?
  if [ "$rc" -ne "$want" ]; then
    bad "$label: exit $rc, expected $want. Output: $out"; return
  fi
  if [ -n "$want_msg" ] && ! printf '%s' "$out" | grep -qF "$want_msg"; then
    bad "$label: exit was right but message did not mention '$want_msg'. Output: $out"; return
  fi
  ok "$label"
}

echo "check-copilot-review-on-push:"

# POSITIVE CONTROL. Without this the whole file is satisfied by a guard that always exits 1.
run_case "the correct ruleset passes" \
  '[{"type":"copilot_code_review","parameters":{"review_on_push":true,"review_draft_pull_requests":false}}]' \
  0 "ok"

# The regression this guard exists for: the exact shape the ruleset held on 2026-09-21.
run_case "review_on_push false fails" \
  '[{"type":"copilot_code_review","parameters":{"review_on_push":false,"review_draft_pull_requests":false}}]' \
  1 "review_on_push = false"

# Deleting the rule is a BIGGER regression than flipping the field, and it is the case a
# naive value check reports clean because it finds nothing to compare.
run_case "the rule being absent fails, rather than passing vacuously" \
  '[{"type":"required_status_checks","parameters":{}},{"type":"merge_queue","parameters":{}}]' \
  1 "no copilot_code_review rule"

run_case "an empty rule list fails" '[]' 1 "no copilot_code_review rule"

# `null` and a missing key are not `true`. Neither should be tolerated: the guard asserts the
# value IS true rather than asserting it is not false, so an unexpected shape fails closed.
run_case "a null review_on_push fails" \
  '[{"type":"copilot_code_review","parameters":{"review_on_push":null}}]' \
  1 "expected true"

run_case "a missing review_on_push key fails" \
  '[{"type":"copilot_code_review","parameters":{}}]' \
  1 "expected true"

# The string "true" is not the boolean true. jq distinguishes them; a grep would not, which
# is half the reason this guard does not use one.
run_case "the STRING \"true\" fails, because it is not the boolean" \
  '[{"type":"copilot_code_review","parameters":{"review_on_push":"true"}}]' \
  1 "expected true"

# Two rulesets can both carry the rule. One correct entry must not vouch for a wrong one.
run_case "one good rule does not vouch for a bad one" \
  '[{"type":"copilot_code_review","parameters":{"review_on_push":true}},{"type":"copilot_code_review","parameters":{"review_on_push":false}}]' \
  1 "expected true"

# A missing subject must be FATAL rather than a quiet pass - tdd.md, "make a missing subject
# FATAL, not a test".
out=$("$GUARD" "$TMP/does-not-exist.json" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  bad "a nonexistent fixture exited 0 - an unreadable subject must never read as clean"
elif ! printf '%s' "$out" | grep -qF "does not exist"; then
  bad "a nonexistent fixture failed, but the message did not say why: $out"
else
  ok "a nonexistent fixture is FATAL and says so"
fi

# No token and no fixture must fail rather than skip. Without this, a token scope change in
# CI would silently convert the guard into a no-op that reports success.
out=$(env -u GH_TOKEN -u GITHUB_TOKEN -u COPILOT_RULESET_FIXTURE "$GUARD" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  bad "with no token and no fixture the guard exited 0 - 'I could not look' must not be 'fine'"
elif ! printf '%s' "$out" | grep -qi "no GH_TOKEN"; then
  bad "no-token case failed but for an unclear reason: $out"
else
  ok "no token and no fixture is FATAL and names the token"
fi

# ---------------------------------------------------------------------------------------
# The NETWORK path. Everything above drives a fixture, which means a wrong URL, a missing
# header or broken ref_name filtering would leave the whole suite green - a review found
# exactly that gap. These cases run the real fetch-and-filter code through a fake curl, so
# they are still hermetic but no longer skip the half that talks to GitHub.
# ---------------------------------------------------------------------------------------

FAKE="$TMP/fake-curl"
cat > "$FAKE" <<'FAKE_CURL'
#!/usr/bin/env bash
# Records every invocation, then answers by URL from files the test wrote.
url="${@: -1}"
printf '%s\n' "$*" >> "$FAKE_CURL_LOG"
printf '%s\n' "$url" >> "$FAKE_CURL_URLS"
if [[ "$url" == */rulesets ]]; then
  cat "$FAKE_CURL_DIR/listing.json"
else
  id="${url##*/}"
  f="$FAKE_CURL_DIR/ruleset-$id.json"
  [ -f "$f" ] || { echo "fake-curl: no fixture for ruleset $id" >&2; exit 22; }
  cat "$f"
fi
FAKE_CURL
chmod +x "$FAKE"

net_run() { # $1 expected exit; rest: nothing. Fixtures are written by the caller.
  : > "$TMP/curl.log"; : > "$TMP/urls.log"
  FAKE_CURL_LOG="$TMP/curl.log" FAKE_CURL_URLS="$TMP/urls.log" FAKE_CURL_DIR="$TMP" \
  GUARD_CURL="$FAKE" GUARD_API_BASE="https://api.example.invalid" \
  GH_TOKEN="test-token" GUARD_REPO="o/r" GUARD_BRANCH="main" \
    env -u COPILOT_RULESET_FIXTURE "$GUARD" 2>&1
}

# One active ruleset targeting the default branch, with the rule correct.
printf '%s' '[{"id":1,"enforcement":"active"}]' > "$TMP/listing.json"
printf '%s' '{"id":1,"conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"]}},"rules":[{"type":"copilot_code_review","parameters":{"review_on_push":true}}]}' > "$TMP/ruleset-1.json"
out=$(net_run); rc=$?
if [ "$rc" -ne 0 ]; then bad "network path: correct ruleset should pass, got exit $rc: $out"
else
  if ! grep -qxF "https://api.example.invalid/repos/o/r/rulesets" "$TMP/urls.log"; then
    bad "network path: never called the LIST endpoint at exactly the expected URL"
  elif ! grep -qxF "https://api.example.invalid/repos/o/r/rulesets/1" "$TMP/urls.log"; then
    bad "network path: never called the DETAIL endpoint at exactly the expected URL"
  elif ! grep -qF "Authorization: Bearer test-token" "$TMP/curl.log"; then
    bad "network path: the Authorization header was not sent"
  elif ! grep -qF -- "--max-time" "$TMP/curl.log"; then
    bad "network path: no bounded timeout - a hung API would sit until the job deadline"
  else
    ok "network path: right URLs, auth header and a bounded timeout"
  fi
fi

# An INACTIVE ruleset carrying a correct rule must not vouch for the repo. If the only
# ruleset is disabled, enforcement is off and that is a bigger regression than a flipped field.
printf '%s' '[{"id":1,"enforcement":"disabled"}]' > "$TMP/listing.json"
out=$(net_run); rc=$?
if [ "$rc" -eq 0 ]; then bad "network path: an inactive-only ruleset passed - enforcement being off must fail"
elif ! printf '%s' "$out" | grep -qF "no ACTIVE ruleset"; then bad "network path: inactive case failed unclearly: $out"
else ok "network path: an inactive ruleset does not vouch for the repo"; fi

# A ruleset that does not target the branch must be IGNORED rather than counted. Without this
# filter, a rule on some other branch would satisfy the check for main.
printf '%s' '[{"id":2,"enforcement":"active"}]' > "$TMP/listing.json"
printf '%s' '{"id":2,"conditions":{"ref_name":{"include":["refs/heads/some-other-branch"]}},"rules":[{"type":"copilot_code_review","parameters":{"review_on_push":true}}]}' > "$TMP/ruleset-2.json"
out=$(net_run); rc=$?
if [ "$rc" -eq 0 ]; then bad "network path: a ruleset targeting another branch was accepted for main"
elif ! printf '%s' "$out" | grep -qF "no copilot_code_review rule"; then bad "network path: wrong-branch case failed unclearly: $out"
else ok "network path: a ruleset targeting another branch is ignored"; fi

# POSITIVE CONTROL for that filter: the same rule, explicitly targeting main, must PASS.
# Without this, a filter that rejected everything would satisfy the case above.
printf '%s' '{"id":2,"conditions":{"ref_name":{"include":["refs/heads/main"]}},"rules":[{"type":"copilot_code_review","parameters":{"review_on_push":true}}]}' > "$TMP/ruleset-2.json"
out=$(net_run); rc=$?
if [ "$rc" -ne 0 ]; then bad "network path: an explicit refs/heads/main target should pass, got: $out"
else ok "network path: POSITIVE CONTROL - an explicit main target is accepted"; fi

# An API error must be FATAL. A guard that treats an unreachable API as a pass is worse than
# no guard, because the green becomes evidence.
printf '%s' '[{"id":9,"enforcement":"active"}]' > "$TMP/listing.json"
rm -f "$TMP/ruleset-9.json"
out=$(net_run); rc=$?
if [ "$rc" -eq 0 ]; then bad "network path: a failed detail fetch exited 0 - unreachable must never read as clean"
elif ! printf '%s' "$out" | grep -qF "could not read ruleset"; then bad "network path: API failure message unclear: $out"
else ok "network path: a failed API call is FATAL and says which call"; fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
