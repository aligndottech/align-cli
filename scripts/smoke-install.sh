#!/usr/bin/env bash
# Install smoke: become the user.
#
# The unit suite imports src/ functions; a user runs `npm i -g @aligndottech/cli`
# and types `align`. Four layers sit between those two and none of them is
# covered by any test: the tsc output in dist/, the package.json "files" list
# (a file missing from it is missing from npm, invisible in a checkout), the
# install weight (the tarball must not drag a 780MB ML runtime back in, ALI-1781), and
# Commander's argv parsing (ALI-422 lived exactly
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
# Every FAIL below is ours and blocks. Exactly one thing is not: huggingface.co (or github.com)
# returning HTTP 429 for the ~23MB embedding model or the ~20MB runtime download, which it does
# to shared runner IPs on a schedule nobody here controls or can see coming. That reports SKIP
# plus a workflow warning and does not fail the run - see is_upstream_model_rate_limit in
# smoke-model.sh, which keys on our own download error wording, the exact status and the host
# on one line.
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
[ -f "$REPO_ROOT/dist/bin.js" ] || { echo "FATAL: dist/bin.js missing - run 'npm run build' first"; exit 1; }
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

CLI_PKG="$PREFIX/lib/node_modules/@aligndottech/cli"
[ -d "$CLI_PKG" ] || CLI_PKG="$PREFIX/node_modules/@aligndottech/cli"   # Windows npm layout

# INSTALL WEIGHT (ALI-1781). A plain `npm install` of this package was 779MB because
# @huggingface/transformers pulled onnxruntime-node (every OS plus CUDA), onnxruntime-web and
# sharp. The on-device runtime is downloaded on first local use instead, so the install itself
# must stay small and must not contain any of them. Two assertions, because they fail differently:
# a re-added dependency shows up as a directory, a bloated tarball only as a size.
INSTALL_KB="$(du -sk "$PREFIX" | cut -f1)"
INSTALL_PKGS="$(find "$PREFIX" \( -path '*/node_modules/*/package.json' -o -path '*/node_modules/@*/*/package.json' \) 2>/dev/null | wc -l | tr -d ' ')"
echo "install weight: $((INSTALL_KB / 1024)) MB across ~$INSTALL_PKGS packages (budget: ${ALIGN_SMOKE_INSTALL_BUDGET_MB:-100} MB)"
HEAVY=""
for d in onnxruntime-node onnxruntime-web onnxruntime-common sharp transformers; do
  found="$(find "$PREFIX" -type d -name "$d" -path '*node_modules*' 2>/dev/null | head -1)"
  [ -n "$found" ] && HEAVY="$HEAVY $found"
done
if [ -n "$(printf '%s' "$HEAVY" | tr -d '[:space:]')" ]; then
  echo "FAIL: the installed package contains the heavy ML dependency chain again: $HEAVY"
  exit 1
fi
if [ "$((INSTALL_KB / 1024))" -gt "${ALIGN_SMOKE_INSTALL_BUDGET_MB:-100}" ]; then
  echo "FAIL: install is $((INSTALL_KB / 1024)) MB, over the ${ALIGN_SMOKE_INSTALL_BUDGET_MB:-100} MB budget (was 779 MB before ALI-1781)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Where the on-device runtime and model cache for this run (ALI-713, ALI-1781).
#
# The CLI keeps both in the user cache dir, never in the install tree, and ALIGN_MODEL_CACHE
# points that at a directory the smoke controls. In CI it is the actions/cache path, used IN
# PLACE: every write is digest-checked and renamed into place, so an interrupted or failed run
# cannot leave bytes a later run would trust, which is what the old copy-in/copy-out and its
# "do not save a poisoned cache" conditions existed to approximate.
#
# Every branch reports what is on disk afterwards, never that something ran: a WARM line means the
# weights are there, a COLD line means the download is about to happen for real.
# ---------------------------------------------------------------------------
MODEL_RATE_LIMITED=0
EMBED_CACHE="${MODEL_CACHE:-$SMOKE_TMP/embed-cache}"
mkdir -p "$EMBED_CACHE"
# Git Bash hands node a POSIX-style /d/a/... path it would read as D:\d\a\...; cygpath -m gives it the
# form it understands, and is absent (so skipped) everywhere else.
if command -v cygpath >/dev/null 2>&1; then export ALIGN_MODEL_CACHE="$(cygpath -m "$EMBED_CACHE")"; else export ALIGN_MODEL_CACHE="$EMBED_CACHE"; fi
model_weights_present() { # <dir>
  [ -d "$1" ] && [ -n "$(find "$1" -type f -name '*.onnx' 2>/dev/null | head -1)" ]
}
runtime_present() { # <dir>
  [ -d "$1/ort" ] && [ -n "$(find "$1/ort" -type f -name '.verified' 2>/dev/null | head -1)" ]
}
if model_weights_present "$EMBED_CACHE" && runtime_present "$EMBED_CACHE"; then
  echo "model cache: WARM - runtime and weights already in $EMBED_CACHE, no download needed"
else
  echo "model cache: COLD - $EMBED_CACHE is missing the runtime or the weights, downloading"
fi

# The runtime bundle's release asset does not exist until someone publishes it (see
# .github/workflows/ort-runtime.yml), and a PR must not depend on that. So, unless the caller
# asks for the hosted one (ALIGN_SMOKE_RUNTIME=hosted, used by the publish workflow's own verify
# job), build the same reproducible bundle from the pinned upstream npm tarballs and point the
# CLI at it. `--check` makes the build fail unless every digest equals the one the CLI will
# demand, so what is tested here is byte-for-byte what gets published.
if [ "${ALIGN_SMOKE_RUNTIME:-local}" != hosted ] && [ -z "${ALIGN_ORT_RUNTIME_URL:-}" ] && ! runtime_present "$EMBED_CACHE"; then
  echo "== build the runtime bundle from the pinned upstream tarballs =="
  ORT_OUT="$SMOKE_TMP/ort-runtime"
  if ! (cd "$REPO_ROOT" && npx tsx scripts/build-ort-runtime.ts --out "$ORT_OUT" --check); then
    echo "FAIL: could not build the runtime bundle (or its digests no longer match src/lib/embedding-assets.ts)"
    exit 1
  fi
  ALIGN_ORT_RUNTIME_URL="$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$ORT_OUT")"
  export ALIGN_ORT_RUNTIME_URL
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
  echo "SKIP: $1 - an upstream host returned HTTP 429 for the embedding model or runtime download."
  echo "      Upstream rate limiting of a shared runner IP, not attributable to this change."
  echo "::warning title=Embedding download rate-limited (429)::$1 was skipped: huggingface.co or github.com rate-limited the model/runtime download. Upstream, not this change - re-run the job."
}

# The only steps that may report SKIP instead of FAIL are the ones that load the on-device
# embedding model: every `step_model` call below, plus the advisory hook's own branch, which
# needs separate handling because it swallows its cause. Everything else keeps using `step`,
# where a failure is unconditionally ours. Grep `step_model` for the current list rather than
# trusting a count written here, which goes stale the first time someone adds a step.
#
# Output is captured rather than streamed because the exit code alone cannot classify these:
# `align --local` and `align connect git` both report a failed batch as a WARNING and
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
step_model "align --local" 600 align --local
if [ "$STEP_RESULT" = pass ]; then assert_import_complete "align --local" "$STEP_OUT"; fi
step_model "align connect git"   300 align connect git --approve --env local --limit 20
if [ "$STEP_RESULT" = pass ]; then assert_import_complete "align connect git" "$STEP_OUT"; fi
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
# (`import git` was the spelling at the time; retired in 0.40.0, ALI-951 - this line records
# what the review said, so it keeps the old name deliberately)
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
# ALI-1135. The two steps above cannot see a config that names an unspawnable command.
# `align mcp --setup` writes NOTHING here - the synthetic HOME above means detectEditors()
# finds no editor, so only its exit code is exercised - and the handshake spawns through a
# shell on Windows, which is exactly what a client like VS Code does not do. This drives the
# WRITE through the installed package and then spawns what it wrote with shell:false.
step "MCP config spawns as written" 60  node "$SCRIPT_DIR/smoke-mcp-config-spawn.mjs" "$CLI_PKG"

rm -f "$TARBALL"

echo "embedding cache after run: $(find "$EMBED_CACHE" -type f 2>/dev/null | wc -l | tr -d ' ') file(s), $(du -sk "$EMBED_CACHE" | cut -f1) KB at $EMBED_CACHE"

# The vector contract, on the CLI's real loader: cosine >= 0.9999 against the reference vectors
# from the stack npm installs shipped before ALI-1781. Skipped when the cache is empty (a 429
# upstream), because a parity run must not become a second download that fails for the same reason.
if model_weights_present "$EMBED_CACHE" && runtime_present "$EMBED_CACHE"; then
  step "embedding parity vs transformers.js on this machine" 300 node "$SCRIPT_DIR/verify-embedding-parity.mjs" "$CLI_PKG" --live
  step "embedding sanity vs the committed vectors" 300 node "$SCRIPT_DIR/verify-embedding-parity.mjs" "$CLI_PKG"
else
  echo "SKIP: embedding parity - no cached runtime and weights to run it against"
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
  echo "SMOKE RESULT: all steps passed except $SKIPPED skipped for an upstream 429 (huggingface.co or github.com)"
  exit 0
fi
echo "SMOKE RESULT: all steps passed"
