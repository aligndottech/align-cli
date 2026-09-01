#!/usr/bin/env bash
# Install smoke: become the user.
#
# The unit suite imports src/ functions; a user runs `npm i -g @aligndottech/cli`
# and types `align`. Four layers sit between those two and none of them is
# covered by any test: the tsc output in dist/, the package.json "files" list
# (a file missing from it is missing from npm, invisible in a checkout), the
# optional install step (@huggingface/transformers, still native - the local graph
# stopped being, see ALI-740), and Commander's argv parsing (ALI-422 lived exactly
# there - green tests, broken CLI). This script packs the real tarball, installs it
# globally into a clean prefix, and runs the cold no-account first-run sequence,
# asserting exit codes.
#
# It covers the NPM artifact. The compiled binary is a different artifact with a
# different failure mode, and has its own suite: scripts/smoke-binary.sh.
#
# It proves nothing about whether the output is USEFUL - that is what human
# testers are for. It proves the sequence a cold user types does not crash.
#
# WHICH FAILURES ARE OURS (ALI-713)
# ---------------------------------
# Every FAIL below is ours and blocks. Exactly one thing is not: huggingface.co returning
# HTTP 429 for the ~23MB embedding model download, which it does to shared runner IPs on a
# schedule nobody here controls or can see coming. That reports SKIP plus a workflow warning
# and does not fail the run - see is_upstream_model_rate_limit in smoke-model.sh, which keys
# on the exact upstream wording, the exact status and the huggingface host on one line.
# A 404, a 503, a proxy failure or "model could not load" with no upstream status in it are
# all OURS and stay red, because "the model would not load" is exactly what a genuinely
# broken model path looks like.
#
# The skip is a last resort, not the fix. The fix is ALIGN_SMOKE_MODEL_CACHE below, which
# takes the network out of the loop entirely; CI leaves one leg uncached on purpose so the
# real download stays under test.
#
# Run locally:  npm run build && bash scripts/smoke-install.sh
# CI:           the install-smoke matrix job (3 OS x 3 Node versions).
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMEOUT="node $SCRIPT_DIR/smoke-timeout.mjs"
# shellcheck source=smoke-model.sh
. "$SCRIPT_DIR/smoke-model.sh"

# Where to keep the downloaded embedding model between runs. Unset (the default) means every
# run downloads it, which is the local-developer behaviour and the cold CI leg's behaviour.
# A relative value is resolved against the repo root ON PURPOSE: the CI cache path is passed
# as a bare name so a Windows `D:\a\...` path never has to survive Git Bash.
MODEL_CACHE="${ALIGN_SMOKE_MODEL_CACHE:-}"
if [ -n "$MODEL_CACHE" ]; then
  case "$MODEL_CACHE" in
    /*|[A-Za-z]:[\\/]*) ;;
    *) MODEL_CACHE="$REPO_ROOT/$MODEL_CACHE" ;;
  esac
fi

# ---------------------------------------------------------------------------
# Preconditions are FATAL, not test failures (a missing subject passes any
# exit-code assertion for the wrong reason - tdd.md, "assert the subject ran").
# ---------------------------------------------------------------------------
[ -f "$REPO_ROOT/dist/index.js" ] || { echo "FATAL: dist/index.js missing - run 'npm run build' first"; exit 1; }
command -v node >/dev/null || { echo "FATAL: node not on PATH"; exit 1; }
command -v npm  >/dev/null || { echo "FATAL: npm not on PATH"; exit 1; }
command -v git  >/dev/null || { echo "FATAL: git not on PATH"; exit 1; }

SMOKE_TMP="$(mktemp -d)"
cleanup() { rm -rf "$SMOKE_TMP" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Isolate the user environment. The CLI writes config via env-paths (HOME /
# XDG_* / APPDATA), and setup --local writes agent-alignment files into the
# cwd. Without this, a local run of the smoke would clobber the developer's
# real align config - and a CI runner's stray editor configs would flip
# `align mcp --setup` interactive.
# ---------------------------------------------------------------------------
FAKE_HOME="$SMOKE_TMP/home"
mkdir -p "$FAKE_HOME"
export HOME="$FAKE_HOME"
export USERPROFILE="$FAKE_HOME"        # Windows
export APPDATA="$FAKE_HOME/AppData/Roaming"
export LOCALAPPDATA="$FAKE_HOME/AppData/Local"
export XDG_CONFIG_HOME="$FAKE_HOME/.config"
export XDG_DATA_HOME="$FAKE_HOME/.local/share"
export XDG_CACHE_HOME="$FAKE_HOME/.cache"
mkdir -p "$APPDATA" "$LOCALAPPDATA" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Smoke Tester" GIT_AUTHOR_EMAIL="smoke@example.invalid"
export GIT_COMMITTER_NAME="Smoke Tester" GIT_COMMITTER_EMAIL="smoke@example.invalid"

# ---------------------------------------------------------------------------
# Pack the real tarball and install it globally into a clean prefix.
# npm pack does NOT run prepublishOnly, hence the dist/ precondition above.
# ---------------------------------------------------------------------------
echo "== pack =="
# pipefail (set above) keeps a pack failure loud through the tail; the rc check
# names it rather than falling through to a confusing empty-name FATAL.
TARBALL_NAME="$(cd "$REPO_ROOT" && npm pack --silent | tail -1)" || { echo "FATAL: npm pack failed"; exit 1; }
TARBALL="$REPO_ROOT/$TARBALL_NAME"
[ -f "$TARBALL" ] || { echo "FATAL: npm pack reported '$TARBALL_NAME' but no such file exists"; exit 1; }
echo "packed: $TARBALL_NAME ($(wc -c < "$TARBALL" | tr -d ' ') bytes)"

echo "== global install into clean prefix =="
PREFIX="$SMOKE_TMP/prefix"
mkdir -p "$PREFIX"
if ! npm install -g --prefix "$PREFIX" --loglevel=error "$TARBALL"; then
  echo "FAIL: global install of the packed tarball failed (native build or files-list problem)"
  exit 1
fi
# POSIX puts binaries in prefix/bin; Windows npm puts align.cmd (plus an
# extensionless sh shim for Git Bash) at the prefix root.
export PATH="$PREFIX/bin:$PREFIX:$PATH"
# On Windows the runnable artifact is align.cmd - the extensionless shim that
# `command -v align` finds is a Git Bash sh script Node's spawn cannot exec
# (ENOENT; it took out all three windows legs on the first CI run). The
# helpers spawn through cmd.exe there, which resolves .cmd via PATHEXT.
ALIGN_BIN="$(command -v align.cmd 2>/dev/null || command -v align || true)"
[ -n "$ALIGN_BIN" ] || { echo "FAIL: 'align' not on PATH after global install"; exit 1; }
echo "installed: $ALIGN_BIN"

# The embedding model's package is an OPTIONAL dependency, and npm drops a failed optional
# subtree SILENTLY - no warning at default loglevel, exit 0. When that happens the failure
# surfaces eight steps later as `align search` dying with "Cannot find package
# '@huggingface/transformers'", which reads as a product bug. It happened twice in a row on
# one PR (#147, node-22 leg): sharp had released that morning, the runner cache was cold, and
# one dropped download failed the whole subtree. This matrix runs only on platforms the model
# SUPPORTS, so absence here is an install failure, never a platform limitation.
#
# Resolved from the installed CLI package's own context - the same resolution the CLI performs
# at runtime - not by peeking at a node_modules path, which hoisting would make a guess.
CLI_PKG="$PREFIX/lib/node_modules/@aligndottech/cli"
[ -d "$CLI_PKG" ] || CLI_PKG="$PREFIX/node_modules/@aligndottech/cli"   # Windows npm layout
embeddings_dep_present() {
  node -e 'require("module").createRequire(process.argv[1] + "/package.json").resolve("@huggingface/transformers")' "$CLI_PKG" >/dev/null 2>&1
}
if ! embeddings_dep_present; then
  echo "WARN: optional dep @huggingface/transformers missing after install - retrying once (transient download drops are the observed cause)"
  npm install -g --prefix "$PREFIX" --loglevel=error "$TARBALL" || true
  if ! embeddings_dep_present; then
    echo "FAIL: @huggingface/transformers did not install on a supported platform, twice."
    echo "      npm skips failed optional deps silently. Before suspecting the CLI, check for a"
    echo "      same-day release of sharp or onnxruntime (cold-cache downloads) or a registry issue."
    exit 1
  fi
  echo "retry recovered the optional dep"
fi
echo "embeddings dep present"

# ---------------------------------------------------------------------------
# Restore the embedding model into the freshly installed package, so the run does
# not have to ask huggingface.co for it (ALI-713).
#
# The CLI is installed into a mktemp prefix the EXIT trap deletes, so the model's
# cache dies with the job unless it is copied in and out explicitly. There is no
# environment variable for that directory - transformers.js reads only HF_TOKEN -
# so the library is ASKED where it caches rather than the convention being rebuilt
# here, which would be a second writer of its fact.
#
# Every branch reports what is actually on disk afterwards, never that the copy ran:
# a WARM line means the weights are there, a COLD line means the download is about
# to happen for real.
# ---------------------------------------------------------------------------
MODEL_RATE_LIMITED=0
HF_CACHE_DIR=""
model_weights_present() { # <dir>
  [ -d "$1" ] && [ -n "$(find "$1" -type f -name '*.onnx' 2>/dev/null | head -1)" ]
}
if [ -n "$MODEL_CACHE" ]; then
  # A failure to locate the cache dir must not fail the smoke: running cold is the
  # status quo, and losing a whole matrix leg over a cache miss would be worse than
  # the problem this fixes.
  if ! HF_CACHE_DIR="$(hf_model_cache_dir "$CLI_PKG")" || [ -z "$HF_CACHE_DIR" ]; then
    HF_CACHE_DIR=""
    echo "WARN: could not ask @huggingface/transformers where it caches - running cold"
  else
    mkdir -p "$HF_CACHE_DIR"
    if [ -d "$MODEL_CACHE" ] && [ -n "$(ls -A "$MODEL_CACHE" 2>/dev/null)" ]; then
      cp -R "$MODEL_CACHE/." "$HF_CACHE_DIR/" || echo "WARN: model cache restore copy failed"
    fi
    if model_weights_present "$HF_CACHE_DIR"; then
      echo "model cache: WARM - weights already in $HF_CACHE_DIR, no download needed"
    else
      echo "model cache: COLD - $MODEL_CACHE holds no weights, downloading from huggingface.co"
    fi
  fi
else
  echo "model cache: COLD - ALIGN_SMOKE_MODEL_CACHE is unset, downloading from huggingface.co"
fi

# ---------------------------------------------------------------------------
# Fixture repo: a cold user's project. Three commits, two with a real BODY
# stating the reason - ALI-804's hasStatedRationale() requires a non-empty
# body (git.ts), so a rationale folded into the subject line alone (the
# original shape here) is filtered out same as a chore commit. Two -m flags
# give each commit a subject and a separate body paragraph.
# ---------------------------------------------------------------------------
FIXTURE="$SMOKE_TMP/project"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q -b main
echo "# demo" > "$FIXTURE/README.md"
git -C "$FIXTURE" add README.md
git -C "$FIXTURE" commit -qm "chore: initial commit"
echo "db=postgres" > "$FIXTURE/config.ini"
git -C "$FIXTURE" add config.ini
git -C "$FIXTURE" commit -qm "feat: use Postgres over SQLite for the main store" \
  -m "We need concurrent writers, and SQLite serializes them."
echo "retries=3" >> "$FIXTURE/config.ini"
git -C "$FIXTURE" add config.ini
git -C "$FIXTURE" commit -qm "fix: cap retries at 3" \
  -m "Bounds queue latency instead of the infinite backoff we had before."

# ---------------------------------------------------------------------------
# The cold sequence. Each step: bounded by a portable timeout, exit code read
# directly, failure names the step. No || fallbacks - a hang or a crash must
# be loud (verification.md, "the defaulting fallback").
# ---------------------------------------------------------------------------
FAILURES=0
SKIPPED=0
fail_step() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

step() { # <name> <timeout-s> <cmd...>
  local name="$1" secs="$2"; shift 2
  echo ""
  echo "== $name =="
  $TIMEOUT "$secs" "$@"
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "PASS: $name"
  else
    fail_step "$name (exit $rc$([ $rc -eq 124 ] && echo ' = TIMED OUT / HUNG'))"
  fi
  return 0
}

skip_upstream() { # <name>
  SKIPPED=$((SKIPPED + 1))
  MODEL_RATE_LIMITED=1
  echo "SKIP: $1 - huggingface.co returned HTTP 429 for the embedding model download."
  echo "      Upstream rate limiting of a shared runner IP, not attributable to this change."
  echo "::warning title=Embedding model download rate-limited (429)::$1 was skipped: huggingface.co rate-limited the ~23MB model download. Upstream, not this change - re-run the job."
}

# The only steps that may report SKIP instead of FAIL are the ones that load the on-device
# embedding model: every `step_model` call below, plus the advisory hook's own branch, which
# needs separate handling because it swallows its cause. Everything else keeps using `step`,
# where a failure is unconditionally ours. Grep `step_model` for the current list rather than
# trusting a count written here, which goes stale the first time someone adds a step.
#
# Output is captured rather than streamed because the exit code alone cannot classify these:
# `align setup --local` and `align import git` both report a failed batch as a WARNING and
# exit 0, which is how the ALI-713 run reported PASS for both while importing nothing.
# classify_step_result therefore reads the 429 before the exit code (see smoke-model.sh).
STEP_OUT=""
STEP_RESULT=""
step_model() { # <name> <timeout-s> <cmd...>
  local name="$1" secs="$2"; shift 2
  echo ""
  echo "== $name =="
  STEP_OUT="$($TIMEOUT "$secs" "$@" 2>&1)"
  local rc=$?
  printf '%s\n' "$STEP_OUT"
  STEP_RESULT="$(classify_step_result "$rc" "$STEP_OUT")"
  case "$STEP_RESULT" in
    skip-upstream) skip_upstream "$name" ;;
    pass)          echo "PASS: $name" ;;
    *)             fail_step "$name (exit $rc$([ $rc -eq 124 ] && echo ' = TIMED OUT / HUNG'))" ;;
  esac
  return 0
}

# An import step that exits 0 having imported nothing is an assertion that cannot fail, and
# it is what let the 429 through twice on the ALI-713 run. Both importing steps report
# "Imported 0 decisions (1 batch failed)" and exit 0; a healthy run says "Imported 2
# decisions" with no batch line at all (checked against a passing job, not assumed).
assert_import_complete() { # <name> <output>
  local warn
  warn="$(printf '%s\n' "$2" | grep -E '[0-9]+ batch(es)? failed' | head -1)"
  [ -n "$warn" ] && fail_step "$1 exited 0 but reported: $(printf '%s' "$warn" | tr -d '\r')"
  return 0
}

cd "$FIXTURE"

step "align --version"          30  align --version
step "align --help"             30  align --help
# setup --local: the no-account path. stdin is closed by the timeout runner, so
# this also asserts the connector multiselect cancels cleanly instead of hanging
# (it has no --approve bypass). It also runs the FIRST git import, which is where
# the ~23MB embedding model is downloaded - the long timeout is that download, not
# the work. (It said ~90MB, quoting the fp32 file the q8 pin exists to avoid; the
# figure local-embeddings.ts already carries is the right one.)
step_model "align setup --local" 600 align setup --local
if [ "$STEP_RESULT" = pass ]; then assert_import_complete "align setup --local" "$STEP_OUT"; fi
step_model "align import git"    300 align import git --approve --env local --limit 20
if [ "$STEP_RESULT" = pass ]; then assert_import_complete "align import git" "$STEP_OUT"; fi
step "align local status"       60  align local status
step_model "align search (local)" 120 align search "postgres" --env local --limit 5
step "align context sync"       60  align context sync --env local
# The sync's whole contract is the written artifact, not its exit code: the
# owned file must exist, and re-running must not change a byte (ALI-602 DoD).
if [ -f .align/decisions.md ]; then
  echo "PASS: context file written"
else
  echo "FAIL: context sync exited 0 but wrote no .align/decisions.md"
  FAILURES=$((FAILURES + 1))
fi
# cmp against a saved copy, not command substitution: $(cat) strips trailing
# newlines, so a re-run differing only at the file's end would compare equal.
cp .align/decisions.md /tmp/ctx-before.md 2>/dev/null || true
step "align context sync (re-run)" 60 align context sync --env local
if [ -s /tmp/ctx-before.md ] && cmp -s /tmp/ctx-before.md .align/decisions.md; then
  echo "PASS: context sync idempotent (byte-identical)"
else
  echo "FAIL: context sync re-run changed the file (or first run wrote nothing)"
  FAILURES=$((FAILURES + 1))
fi
rm -f /tmp/ctx-before.md
# `align ask` with no provider key: the ranked list still comes back, plus the hint. This is
# the shape a first-run dev sees, so it must exit 0 rather than treating a missing key as an
# error (the CI runner has no ANTHROPIC_API_KEY, which is the point).
#
# ONE token, and it has to stay that way: smoke-timeout.mjs spawns through a shell on win32,
# which quotes nothing, so `"why postgres"` arrived as two arguments and Commander bound
# query="why" while silently discarding the rest. The runner refuses a space-bearing argument
# outright now, so this is enforced rather than remembered.
step_model "align ask (local, no key)" 120 align ask postgres --env local --limit 5
# The agent hook, on the payload Claude Code actually pipes. Retrieval only, so it needs no
# provider key and makes no provider call - and in local mode that is not just a latency
# choice, it is the only egress in the pipeline (local-gateway-client.ts honours depth).
#
# The content shares vocabulary with the Postgres commit seeded above so it clears the
# retrieval floor comfortably. This step tests the hook, not the threshold.
ADVISORY_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"config.ini","content":"replace Postgres with MySQL for the main store, dropping concurrent writers"}}'
# ONE invocation, captured - deliberately not a `step` call plus a capture call. The hook dedups
# against decisions it surfaced moments ago (advisory-dedup.ts, keyed on cwd), which is correct
# product behaviour and means a second identical run legitimately prints nothing. Running it
# twice is what made the first version of this check fail in CI while the hook was working.
echo ""
echo "== align check --advisory =="
# --stdin-file, not a shell pipeline. `sh -c "printf ... | align ..."` was mangled on win32 by
# the same unquoted argv join that broke the ask step: `sh` received `printf` as a separate
# word, printed nothing, and align read an empty stdin - which is indistinguishable from a hook
# that legitimately had nothing to say. The runner now opens the file itself, so no shell is
# involved and an unreadable payload fails loudly.
PAYLOAD_FILE="$SMOKE_TMP/advisory-payload.json"
printf '%s' "$ADVISORY_PAYLOAD" > "$PAYLOAD_FILE"
ADVISORY_OUT=$($TIMEOUT --stdin-file "$PAYLOAD_FILE" 60 align check --advisory --env local 2>/dev/null)
ADVISORY_RC=$?
echo "$ADVISORY_OUT"
# Asserted on the OUTPUT, because --advisory always exits 0 by design and an exit-code check
# therefore cannot fail on a hook that printed nothing. It separates a working hook from a
# silent one and from the give-up path, which says "could not check" instead.
#
# What it does NOT catch, measured rather than assumed: reinstating the adjudicating LLM path
# prints this same wording, because check.ts renders whatever `relevant_decisions` holds and
# both paths populate it. Injecting that regression here took the hook from 700ms to 2711ms and
# still passed. The no-egress property is pinned by the unit test instead ("depth related
# retrieves without ever invoking the classifier"), which can assert the classifier was never
# called; a latency bound is the only e2e signal and it would be flaky on a shared runner.
#
# Asserted on EVERY platform. A previous version of this block excused Windows, citing two
# defects that do not exist: it claimed `import git` duplicated only there and that Windows
# embeddings scored below threshold. Both were wrong. All nine legs reported the same 4-decision
# graph, and Windows `search "postgres"` scored 0.51 against ubuntu's 0.51 - the divergence was
# this harness mangling any argument containing a space, which is fixed above and now refused
# outright by the runner. A platform excuse that turns out to be a harness bug is worse than a
# red gate, because it teaches the next reader to stop looking.
#
# The 429 case needs its own branch, and it is the one place the skip is inferred rather than
# read: the hook DELIBERATELY swallows the cause and prints "could not check", so unlike every
# other step its own output carries no evidence of why. So it may skip only when BOTH hold -
# an earlier step in this same run produced the definitive 429 signature, AND the hook took
# exactly its documented give-up path. Either condition alone leaves it a failure.
if [ "$ADVISORY_RC" -ne 0 ]; then
  fail_step "advisory hook exited $ADVISORY_RC$([ "$ADVISORY_RC" -eq 124 ] && echo ' = TIMED OUT / HUNG')"
elif printf '%s' "$ADVISORY_OUT" | grep -q "NOT been adjudicated"; then
  echo "PASS: advisory hook surfaced related decisions, retrieval-only, with no provider key"
elif [ "$MODEL_RATE_LIMITED" -eq 1 ] && printf '%s' "$ADVISORY_OUT" | grep -q "could not check this change"; then
  skip_upstream "advisory hook"
else
  fail_step "advisory hook did not take the retrieval path (exit 0). Got: ${ADVISORY_OUT:-<no output>}"
fi
step "align mcp --setup"        60  align mcp --setup --env local
# Bare name, not $ALIGN_BIN: the handshake helper spawns through cmd.exe on
# Windows, and cmd resolves `align` -> align.cmd via PATH + PATHEXT, while the
# full POSIX-style path to the sh shim is unrunnable there.
step "MCP handshake"            60  node "$SCRIPT_DIR/smoke-mcp-handshake.mjs" align

rm -f "$TARBALL"

# ---------------------------------------------------------------------------
# Save the model back out, for the NEXT run. Three conditions, all of them about not
# poisoning the cache: a run that hit a 429 has an incomplete cache, a directory with
# no weights in it is not worth restoring, and a run with ANY failure in it may have
# failed BECAUSE of the model - measured, not theorised: truncating the cached weights
# reproduces the incident's exact five failures, and without this condition the run
# then saved the truncated file straight back. When none holds, MODEL_CACHE is left
# ABSENT rather than created empty - actions/cache stores nothing for a path that does
# not exist, where an empty directory would be stored and then restored forever,
# quietly guaranteeing a cold download it also stops reporting as cold.
# ---------------------------------------------------------------------------
if [ -n "$MODEL_CACHE" ] && [ -n "$HF_CACHE_DIR" ]; then
  if [ "$MODEL_RATE_LIMITED" -ne 0 ]; then
    echo "model cache: NOT SAVED - this run hit an upstream 429, so its cache is incomplete"
  elif [ "$FAILURES" -ne 0 ]; then
    echo "model cache: NOT SAVED - $FAILURES step(s) failed, so these weights are not known good"
  elif ! model_weights_present "$HF_CACHE_DIR"; then
    echo "model cache: NOT SAVED - no model weights under $HF_CACHE_DIR"
  else
    mkdir -p "$MODEL_CACHE"
    if cp -R "$HF_CACHE_DIR/." "$MODEL_CACHE/"; then
      echo "model cache: saved to $MODEL_CACHE ($(find "$MODEL_CACHE" -type f 2>/dev/null | wc -l | tr -d ' ') files)"
    else
      echo "WARN: model cache save copy failed"
    fi
  fi
fi

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "SMOKE RESULT: $FAILURES step(s) failed, $SKIPPED skipped upstream"
  exit 1
fi
if [ "$SKIPPED" -ne 0 ]; then
  # Deliberately exit 0. The skip is narrow (see the header) and loud (a workflow warning
  # per step), and the alternative is a red gate nobody can act on: on the run that prompted
  # this, a re-run passed with no code change and the only remedy available to the author was
  # to notice the red was not theirs - which is the same reading that excuses a real failure.
  echo "SMOKE RESULT: all steps passed except $SKIPPED skipped for an upstream huggingface.co 429"
  exit 0
fi
echo "SMOKE RESULT: all steps passed"
