#!/usr/bin/env bash
# Guards for scripts/smoke-model.sh, which decides two things the install smoke cannot
# decide safely inline: whether a failed step is OUR defect or huggingface.co / github.com
# rate-limiting a shared runner IP while we fetch the embedding runtime or model.
#
# The second one is a fail-open surface, which is why it is a tested function rather than a
# grep in the smoke script. The shape it must not become is a check that reports
# "fine" because it could not tell. So the predicate is deliberately narrow - the exact
# wording our downloader emits, the exact status, and the host, all on ONE line - and
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

# The line as OUR downloader produces it, taken from the real implementation against a server
# answering the given status - never pasted, so the predicate and the wording cannot drift apart.
# The host in the message is the one fetched, so a 127.0.0.1 server is rewritten to the upstream
# host the production URLs carry; everything else is the real sentence.
download_error_line() { # <status> <upstream-url>
  (cd "$REPO_ROOT" && STATUS="$1" UPSTREAM="$2" npx tsx -e '
    (async () => {
      const { createServer } = await import("node:http");
      const { fetchVerified } = await import("./src/lib/verified-download.ts");
      const s = createServer((_q, r) => { r.statusCode = Number(process.env.STATUS); r.end(); });
      await new Promise((res) => s.listen(0, "127.0.0.1", res));
      const url = `http://127.0.0.1:${s.address().port}/x`;
      const err = await fetchVerified(url, { sha256: "0".repeat(64), maxBytes: 10 }).catch((e) => e);
      s.close();
      const u = new URL(process.env.UPSTREAM);
      process.stdout.write(String(err.message).replace(url, process.env.UPSTREAM).replace(/^[^ ]+ answered/, u.host + " answered"));
    })();
  ' 2>/dev/null)
}

RATE_LIMIT_LINE="align: ✖ Could not set up the on-device embedding model. $(download_error_line 429 https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff3/onnx/model_quantized.onnx)"
# Positive control for the helper: a helper that printed nothing would make every assertion below
# compare against an empty string.
case "$RATE_LIMIT_LINE" in
  *"answered HTTP 429 for https://huggingface.co/"*) ok "the real downloader emits the 429 sentence the predicate keys on" ;;
  *) bad "download_error_line did not produce the expected sentence: $RATE_LIMIT_LINE" ;;
esac

# --- is_upstream_model_rate_limit ------------------------------------------------------

if is_upstream_model_rate_limit "$RATE_LIMIT_LINE"; then
  ok "recognises the 429 our downloader emits for the model"
else
  bad "did not recognise the 429 our downloader emits for the model"
fi

# Second example, so what is pinned is the RULE and not one literal: the runtime asset on github.com.
if is_upstream_model_rate_limit "$(download_error_line 429 https://github.com/aligndottech/align-cli/releases/download/ort-runtime-v1.30.0/align-ort-1.30.0-linux-x64.tgz)"; then
  ok "recognises the same 429 for the runtime asset on github.com"
else
  bad "matched only the model URL, so it pins a literal rather than the rule"
fi

# 404 is the case this must never swallow: it is what a wrong model revision, a removed file or
# a release asset nobody published produces, and skipping it would let a broken download path
# pass silently.
if is_upstream_model_rate_limit "$(download_error_line 404 https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff3/onnx/model_quantized.onnx)"; then
  bad "treated a 404 (broken model path) as an upstream rate limit"
else
  ok "refuses a 404 - a broken download path stays our defect"
fi

if is_upstream_model_rate_limit "$(download_error_line 503 https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff3/tokenizer.json)"; then
  bad "treated a 503 as an upstream rate limit"
else
  ok "refuses a 503"
fi

if is_upstream_model_rate_limit "$(download_error_line 429 https://internal-mirror.example.invalid/models/model_quantized.onnx)"; then
  bad "treated a 429 from a non-upstream host as the upstream rate limit"
else
  ok "refuses a 429 from a different host"
fi

# Our own wrapper text (local-embeddings.ts) with no upstream status in it. This is what a
# proxy failure, an offline runner or a corrupt cache produces, and all three are ours.
if is_upstream_model_rate_limit 'Could not set up the on-device embedding model (~23MB model, ~20MB runtime). Check your internet connection or proxy and try again. (could not reach huggingface.co: fetch failed)'; then
  bad "matched our own wrapper message with no upstream status in it"
else
  ok "refuses a setup failure that carries no upstream 429"
fi

if is_upstream_model_rate_limit 'imported 429 decisions from huggingface.co in 12s'; then
  bad "matched incidental text containing 429 and the host"
else
  ok "refuses incidental text containing both 429 and the host"
fi

# The single-line requirement, stated as a test: an unrelated 429 elsewhere in a long log
# plus an unrelated huggingface URL elsewhere must not combine into a match.
if is_upstream_model_rate_limit 'someother.invalid answered HTTP 429 for https://someother.invalid/x
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
expect_class fail          "rc=1 with a 404"                           1   "$(download_error_line 404 https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff3/onnx/model_quantized.onnx)"
expect_class fail          "rc=124 (hung) with no output"              124 ''
expect_class fail          "rc=1 with a setup failure and no 429"      1   'Could not set up the on-device embedding model. (fetch failed)'

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "SMOKE MODEL GUARDS: $FAILURES failed"
  exit 1
fi
echo "SMOKE MODEL GUARDS: all passed"
