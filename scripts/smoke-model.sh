#!/usr/bin/env bash
# What the install smoke needs to know about the on-device embedding downloads: how to tell
# huggingface.co or github.com rate-limiting a shared runner IP from a defect of ours.
#
# Sourced, never executed - it only defines functions. Guards: scripts/__tests__/test-smoke-model.sh.
#
# This is a separate, tested file rather than a few greps inside smoke-install.sh because one of
# these functions decides whether a red gate becomes a warning. An untested predicate in that
# position is the shape: a check that reports "fine" because it could not tell.

# True when the text carries huggingface.co or github.com refusing an embedding download with
# HTTP 429.
#
# Narrow on purpose, in three ways at once, because everything it matches stops failing the
# build: the exact wording OUR downloader emits (verified-download.ts), the exact status, and
# the host - all on ONE line. grep is line-based, so the single-line requirement comes for free
# and an unrelated 429 elsewhere in a long log cannot pair up with an unrelated URL.
#
# The wording is ours now (it used to be transformers.js's), so the test suite
# produces it from the real downloader rather than pasting a literal that could drift:
#   "<host> answered HTTP <status> for <url>"
# 404 and 503 use the same sentence with their own status, so the status is what the predicate
# keys on, and test-smoke-model.sh proves a 404 and a 503 are refused.
is_upstream_model_rate_limit() {
  printf '%s\n' "${1-}" |
    grep -qE 'answered HTTP 429 for https://(huggingface\.co|github\.com)/'
}

# pass | fail | skip-upstream, for one smoke step that needs the model.
#
# The 429 is read BEFORE the exit code, and that ordering is the point: `align connect git`
# exited 0 on the run while reporting "Imported 0 decisions (1 batch failed)", so the
# exit code alone certified an empty graph as a pass. A step whose output carries the upstream
# 429 has not tested anything, whatever it exited with.
classify_step_result() { # <rc> <output>
  local rc="${1-1}" out="${2-}"
  if is_upstream_model_rate_limit "$out"; then
    printf 'skip-upstream\n'
    return 0
  fi
  if [ "$rc" -eq 0 ]; then printf 'pass\n'; else printf 'fail\n'; fi
}
