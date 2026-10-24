#!/usr/bin/env bash
# Guards for scripts/check-no-private-ticket-refs.sh.
#
# Every case builds a throwaway git repo, so the guard's proof never depends on the state of
# this checkout. The ref is assembled from two halves below: written whole, it would be a
# ticket reference in a tracked file and fail the very guard under test.
#
# THE POSITIVE CONTROL IS THE LOAD-BEARING ONE. A guard that fails on everything passes every
# "it goes red when X" case, and would then block every PR. So the clean repo must go GREEN.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check-no-private-ticket-refs.sh"

[ -x "$GUARD" ] || { echo "FATAL: $GUARD is missing or not executable"; exit 1; }

REF="ALI""-123"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok: $1"; }
bad() { fail=$((fail+1)); echo "  FAIL: $1" >&2; }

# A fresh repo with one clean tracked file. Echoes its path.
new_repo() {
  local d; d="$(mktemp -d "$TMP/repo.XXXXXX")"
  git -C "$d" init -q
  git -C "$d" config user.email t@example.com
  git -C "$d" config user.name t
  mkdir -p "$d/src"
  printf 'export const x = 1;\n' > "$d/src/clean.ts"
  git -C "$d" add -A
  echo "$d"
}

# $1 label, $2 repo, $3 expected exit, $4 substring that must appear, $5 substring that must NOT appear
check() {
  local label="$1" repo="$2" want="$3" want_msg="${4:-}" refuse_msg="${5:-}"
  local out rc
  out=$(TICKET_REF_ALLOWLIST="${ALLOW-}" "$GUARD" "$repo" 2>&1); rc=$?
  if [ "$rc" -ne "$want" ]; then bad "$label: exit $rc, expected $want. Output: $out"; return; fi
  if [ -n "$want_msg" ] && ! printf '%s' "$out" | grep -qF -- "$want_msg"; then
    bad "$label: exit was right but output did not mention '$want_msg'. Output: $out"; return
  fi
  if [ -n "$refuse_msg" ] && printf '%s' "$out" | grep -qF -- "$refuse_msg"; then
    bad "$label: output mentioned '$refuse_msg' and must not. Output: $out"; return
  fi
  ok "$label"
}

echo "check-no-private-ticket-refs:"
ALLOW=""

# POSITIVE CONTROL.
r=$(new_repo)
check "a clean repo passes" "$r" 0 "ok:"

# The regression this guard exists for.
r=$(new_repo); printf '// %s: the reason\n' "$REF" > "$r/src/bad.ts"; git -C "$r" add -A
check "a ref in a source comment fails and names file and line" "$r" 1 "src/bad.ts:1:"

r=$(new_repo); printf 'See %s for more.\n' "$REF" > "$r/README.md"; git -C "$r" add -A
check "a ref in markdown fails" "$r" 1 "README.md:1:"

r=$(new_repo); mkdir -p "$r/.github/workflows"; printf '# %s\non: push\n' "$REF" > "$r/.github/workflows/ci.yml"; git -C "$r" add -A
check "a ref in a workflow comment fails" "$r" 1 ".github/workflows/ci.yml:1:"

r=$(new_repo); printf '{"k":"%s"}\n' "$REF" > "$r/data.json"; git -C "$r" add -A
check "a ref in a data file fails" "$r" 1 "data.json:1:"

# Near misses must stay green, or the guard flags prose that names no ticket.
r=$(new_repo); printf 'ALI is a Jira project key. ALI-<n> is a placeholder. ALIGN-1 is not ours.\n' > "$r/src/prose.ts"; git -C "$r" add -A
check "a bare prefix and a placeholder do not trip it" "$r" 0 "ok:"

# Untracked files are out of scope by design (node_modules, scratch).
r=$(new_repo); printf '%s\n' "$REF" > "$r/scratch.txt"
check "an untracked file is not read" "$r" 0 "ok:"

# The allowlist.
r=$(new_repo); printf '{"k":"%s"}\n' "$REF" > "$r/frozen.json"; git -C "$r" add -A
ALLOW="frozen.json"
check "an allowlisted file that holds a ref passes" "$r" 0 "ok:"

printf '// %s\n' "$REF" > "$r/src/bad.ts"; git -C "$r" add -A
check "an allowlisted file does not excuse a different file" "$r" 1 "src/bad.ts:1:" "frozen.json:1:"

ALLOW="frozen.json"
r=$(new_repo); printf '{"k":1}\n' > "$r/frozen.json"; git -C "$r" add -A
check "an allowlist entry with no ref left is stale and fails" "$r" 1 "no longer contains a ticket ref"

ALLOW="missing.json"
r=$(new_repo)
check "an allowlist entry for a file that does not exist fails" "$r" 1 "missing.json"

ALLOW="src"
r=$(new_repo); printf '// %s\n' "$REF" > "$r/src/bad.ts"; git -C "$r" add -A
check "the allowlist is exact paths, not a directory prefix" "$r" 1 "src/bad.ts:1:"

# A check that examined nothing must not pass.
ALLOW=""
r="$(mktemp -d "$TMP/empty.XXXXXX")"; git -C "$r" init -q
check "an empty repo fails rather than passing vacuously" "$r" 1 "examined nothing"

nogit="$(mktemp -d "$TMP/nogit.XXXXXX")"
check "a directory that is not a git checkout fails" "$nogit" 1 "not a git checkout"

# The real tree, with the real allowlist.
ALLOW_REAL=$("$GUARD" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then ok "this repository is clean under its real allowlist"; else bad "this repository: $ALLOW_REAL"; fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
