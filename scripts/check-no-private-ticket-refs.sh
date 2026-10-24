#!/usr/bin/env bash
# Fails when a tracked file names a private Linear ticket (the key shape is the three letters
# A-L-I, a hyphen and digits).
#
# This repo is public. Those tickets live in a private workspace, so to an outside reader a key
# like that is a dead reference: it explains nothing and cannot be opened. The reason a comment
# was written belongs in the comment; the ticket number does not.
#
# Usage: scripts/check-no-private-ticket-refs.sh [repo-root]   (default: this repo)
#
# WHAT IT READS. `git grep` over TRACKED files only, so node_modules, dist and untracked
# scratch cannot matter. It is a text check: it cannot see a ref inside a PNG or a built
# bundle, and it says nothing about refs spelled another way ("ali 123", "ALI_123").
#
# THE ALLOWLIST BELOW IS EXACT PATHS, never globs, and each entry says why the file cannot be
# cleaned. Every entry must still contain a ref: an entry that no longer does is a stale
# exemption that would hide a future reintroduction, so the guard fails on it. Adding a path
# here is a deliberate act with its reason in the PR; the right default for a new ref is to
# delete it from the comment, not to list the file.
#
# TICKET_REF_ALLOWLIST (newline-separated paths) replaces the list for the guard's own tests.
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

DEFAULT_ALLOWLIST='src/__tests__/fixtures/source-key-v7-frozen.json
src/__tests__/fixtures/embedding-parity.json
src/__tests__/fixtures/decision-render-fixture.json
scripts/retrieval-eval-v2-questions.json
src/detector/resolve-pair.ts
src/detector/similar-item.ts
src/lib/mcp-instructions.shared.ts'
# source-key-v7-frozen.json: pinned by SHA-256 in source-key.test.ts, and its sample Jira keys
#   are inputs to a frozen normaliser table. Editing a byte breaks the pin on purpose.
# embedding-parity.json: reference vectors computed from the exact text of real commit
#   messages. Changing the text invalidates the vectors.
# decision-render-fixture.json: must stay byte-identical to the align-stack copy (two repos,
#   no shared filesystem), so it cannot be edited from here alone. Its $comment names a ticket.
# retrieval-eval-v2-questions.json: a generated eval corpus. "subject" records a real commit
#   subject at a pinned clone_sha, and the harness compares questions against it.
# resolve-pair.ts, similar-item.ts: vendored from align-stack and pinned by SHA-256 in
#   src/detector/detector.lock.json (detector-lock.test.ts). A header comment is a byte.
# mcp-instructions.shared.ts: must stay byte-identical to align-stack's copy
#   (mcp-instructions-parity.test.ts), so a one-sided edit fails that test.

ALLOWLIST="${TICKET_REF_ALLOWLIST-$DEFAULT_ALLOWLIST}"
PATTERN='ALI-[0-9]+'

git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || { echo "FAIL: $ROOT is not a git checkout"; exit 1; }

tracked=$(git -C "$ROOT" ls-files | wc -l | tr -d ' ')
if [ "$tracked" -eq 0 ]; then
  echo "FAIL: git ls-files returned nothing in $ROOT, so this check examined nothing."
  echo "Run it from a checkout with tracked files; an empty tree is not a clean tree."
  exit 1
fi

rc=0

# Stale allowlist entries first.
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if ! git -C "$ROOT" grep -I -q -E "$PATTERN" -- "$p" 2>/dev/null; then
    echo "FAIL: allowlisted path '$p' no longer contains a ticket ref (or does not exist)."
    echo "Remove it from the allowlist in scripts/check-no-private-ticket-refs.sh: a stale entry would hide a ref reintroduced later."
    rc=1
  fi
done <<< "$ALLOWLIST"

# Every tracked ref outside the allowlist.
# git grep exits 1 for "no match" and >1 for a real error; only the first is clean.
hits=$(git -C "$ROOT" grep -I -n -E "$PATTERN" -- . 2>/dev/null); grep_rc=$?
if [ "$grep_rc" -gt 1 ]; then echo "FATAL: git grep failed (exit $grep_rc), so the tree was not checked" >&2; exit 2; fi
bad=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  if printf '%s\n' "$ALLOWLIST" | grep -qxF -- "$file"; then continue; fi
  bad="${bad}${line:0:200}"$'\n'
done <<< "$hits"

if [ -n "$bad" ]; then
  echo "FAIL: private ticket reference(s) in tracked files (this repo is public; readers cannot open them):"
  printf '%s' "$bad"
  echo "Say why in the comment or test name instead, and delete the key. If the file genuinely cannot change, add its exact path to the allowlist with the reason."
  rc=1
fi

[ "$rc" -eq 0 ] && echo "ok: no private ticket references in $tracked tracked files"
exit "$rc"
