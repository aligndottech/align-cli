#!/usr/bin/env bash
# Guards for scripts/smoke-model.sh, which decides two things the install smoke cannot
# decide safely inline: where the on-device embedding model caches, and whether a failed
# step is OUR defect or huggingface.co rate-limiting a shared runner IP.
#
# The second one is a fail-open surface, which is why it is a tested function rather than a
# grep in the smoke script. ALI-348 is the shape it must not become: a check that reports
# "fine" because it could not tell. So the predicate is deliberately narrow - the exact
# transformers.js wording, the exact status, and the huggingface host, all on ONE line - and
# most of the cases below are negative controls proving it refuses everything else.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$SCRIPT_DIR/smoke-model.sh"
FAILURES=0

# A missing subject satisfies most assertions below for the wrong reason, so it is FATAL
# rather than a failing test (tdd.md, "make a missing subject fatal, not a test").
[ -f "$LIB" ] || { echo "FATAL: $LIB is missing"; exit 1; }
# shellcheck source=../smoke-model.sh
. "$LIB"
command -v node >/dev/null || { echo "FATAL: node not on PATH"; exit 1; }

ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# The line as huggingface.co actually produced it, copied from the ALI-713 job log
# (run 33101077210 attempt 1, install-smoke windows-2022/22). A hand-written approximation
# would let the predicate drift away from the only string it exists to recognise.
RATE_LIMIT_LINE='align: ✖ Could not load the local embedding model (~23MB, Xenova/all-MiniLM-L6-v2, from huggingface.co). Check your internet connection or proxy and try again. (Error (429) occurred while trying to load file: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx".)'

# --- is_upstream_model_rate_limit ------------------------------------------------------

if is_upstream_model_rate_limit "$RATE_LIMIT_LINE"; then
  ok "recognises the verbatim 429 from the incident log"
else
  bad "did not recognise the verbatim 429 from the incident log"
fi

# Second example, so what is pinned is the RULE and not that one literal: the same wording
# for a different file under the same host (tdd.md, two examples per rule).
if is_upstream_model_rate_limit 'Error (429) occurred while trying to load file: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json".'; then
  ok "recognises the same 429 wording for another file on the same host"
else
  bad "matched only the incident's exact URL, so it pins a literal rather than the rule"
fi

# 404 is the case this must never swallow: it is what a genuinely wrong model id or a
# removed file produces, and skipping it would let a broken model path pass silently.
# transformers.js maps 404 to different wording entirely (hub/constants.js), which is why
# the predicate keys on the whole phrase and not on the status number.
if is_upstream_model_rate_limit 'Could not locate file: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx".'; then
  bad "treated a 404 (broken model path) as an upstream rate limit"
else
  ok "refuses a 404 - a broken model path stays our defect"
fi

if is_upstream_model_rate_limit 'Service unavailable error occurred while trying to load file: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx".'; then
  bad "treated a 503 as an upstream rate limit"
else
  ok "refuses a 503"
fi

if is_upstream_model_rate_limit 'Error (429) occurred while trying to load file: "https://internal-mirror.example.invalid/models/model_quantized.onnx".'; then
  bad "treated a 429 from a non-huggingface host as the upstream model rate limit"
else
  ok "refuses a 429 from a different host"
fi

# Our own wrapper text (local-embeddings.ts) with no upstream cause in it. This is what a
# proxy failure, an offline runner or a corrupt cache produces, and all three are ours.
if is_upstream_model_rate_limit 'Could not load the local embedding model (~23MB, Xenova/all-MiniLM-L6-v2, from huggingface.co). Check your internet connection or proxy and try again. (fetch failed)'; then
  bad "matched our own wrapper message with no upstream status in it"
else
  ok "refuses a model-load failure that carries no upstream 429"
fi

if is_upstream_model_rate_limit 'imported 429 decisions from huggingface.co in 12s'; then
  bad "matched incidental text containing 429 and the host"
else
  ok "refuses incidental text containing both 429 and the host"
fi

# The single-line requirement, stated as a test: an unrelated 429 elsewhere in a long log
# plus an unrelated huggingface URL elsewhere must not combine into a match.
if is_upstream_model_rate_limit 'Error (429) occurred while trying to load file: "https://someother.invalid/x".
downloading https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json'; then
  bad "combined a 429 on one line with a huggingface URL on another"
else
  ok "requires the status and the host on the same line"
fi

if is_upstream_model_rate_limit ''; then
  bad "matched empty output"
else
  ok "refuses empty output"
fi

# --- classify_step_result --------------------------------------------------------------

expect_class() { # <expected> <label> <rc> <output>
  local expected="$1" label="$2" rc="$3" out="$4"
  local got; got="$(classify_step_result "$rc" "$out")"
  if [ "$got" = "$expected" ]; then
    ok "$label -> $expected"
  else
    bad "$label -> got '$got', expected '$expected'"
  fi
}

expect_class pass          "rc=0 with clean output"                    0   'Found 2 items from git history'
expect_class skip-upstream "rc=1 with the upstream 429"                1   "$RATE_LIMIT_LINE"
# The case the ticket's own step list missed: `align import git` EXITED 0 while importing
# nothing, because it reports a failed batch as a warning. The 429 has to be read before the
# exit code or the smoke certifies an empty graph as a pass.
expect_class skip-upstream "rc=0 but the output carries the 429"       0   "$RATE_LIMIT_LINE"
expect_class fail          "rc=1 with a 404"                           1   'Could not locate file: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx".'
expect_class fail          "rc=124 (hung) with no output"              124 ''
expect_class fail          "rc=1 with a model-load failure and no 429" 1   'Could not load the local embedding model (~23MB, Xenova/all-MiniLM-L6-v2, from huggingface.co). (fetch failed)'

# --- hf_model_pkg_dir / hf_model_cache_dir ---------------------------------------------

# Resolved from THIS repo, which has the optional dep installed - so an empty answer here is
# a broken helper, never a legitimate "not installed".
PKG_DIR="$(hf_model_pkg_dir "$REPO_ROOT")"; rc=$?
if [ $rc -eq 0 ] && [ -n "$PKG_DIR" ] && [ -f "$PKG_DIR/package.json" ] &&
   grep -q '"@huggingface/transformers"' "$PKG_DIR/package.json"; then
  ok "hf_model_pkg_dir finds the installed package root"
else
  bad "hf_model_pkg_dir returned '$PKG_DIR' (rc=$rc), which is not the package root"
fi

# The cache directory is READ FROM THE LIBRARY (env.cacheDir), not assembled from a
# remembered convention - it is the library's own answer, so it cannot drift from it
# (code-style.md, "a type and a database constraint are two writers of one fact").
CACHE_DIR="$(hf_model_cache_dir "$REPO_ROOT")"; rc=$?
if [ $rc -eq 0 ] && [ -n "$CACHE_DIR" ] && case "$CACHE_DIR" in "$PKG_DIR"*) true;; *) false;; esac; then
  ok "hf_model_cache_dir returns a path inside the package root"
else
  bad "hf_model_cache_dir returned '$CACHE_DIR' (rc=$rc), not a path under '$PKG_DIR'"
fi

# The negative direction: a directory with no such dependency must fail loudly and print
# nothing, or the smoke would copy the model cache into an empty string.
NODEP="$(mktemp -d)"
printf '{"name":"nodep","version":"0.0.0"}' > "$NODEP/package.json"
OUT="$(hf_model_cache_dir "$NODEP" 2>/dev/null)"; rc=$?
if [ $rc -ne 0 ] && [ -z "$OUT" ]; then
  ok "hf_model_cache_dir fails loudly, printing nothing, where the dep is absent"
else
  bad "hf_model_cache_dir returned '$OUT' (rc=$rc) for a package with no transformers dep"
fi
rm -rf "$NODEP"

# --- the assumption the predicate rests on ---------------------------------------------

# transformers.js maps known statuses to specific wording and falls through to
# `Error (<status>) occurred while trying to load file` for the rest. 429 is in the
# fall-through set, which is the ONLY reason the predicate above matches anything. If a
# dependency bump gives 429 its own phrase, this test says so - rather than the smoke
# quietly going back to failing red on every rate limit with nobody knowing why.
MAPPING_FILES=$(ls "$PKG_DIR"/dist/transformers.node.* 2>/dev/null | grep -vE '\.map$' || true)
if [ -z "$MAPPING_FILES" ]; then
  bad "found no built transformers entry under $PKG_DIR/dist to check the status mapping"
else
  mapping_ok=1
  for f in $MAPPING_FILES; do
    # Positive control first: if 404's phrase is absent, this parse found the wrong thing and
    # the 429 assertion below would pass vacuously. Whitespace-tolerant because two of the four
    # built entries are minified - an anchored pattern found nothing in those and said so, which
    # is the control doing its job.
    if ! grep -qE '404:[[:space:]]*"Could not locate file"' "$f"; then
      bad "status mapping not found in $(basename "$f") - the 429 check below would be vacuous"
      mapping_ok=0
      continue
    fi
    if grep -qE '429:[[:space:]]*"' "$f"; then
      bad "$(basename "$f") now maps 429 to its own phrase - the smoke's 429 predicate no longer matches"
      mapping_ok=0
    fi
  done
  [ "$mapping_ok" -eq 1 ] && ok "429 is still in the generic fall-through the predicate matches"
fi

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "SMOKE MODEL GUARDS: $FAILURES failed"
  exit 1
fi
echo "SMOKE MODEL GUARDS: all passed"
