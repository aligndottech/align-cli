#!/usr/bin/env bash
# Install smoke: become the user.
#
# The unit suite imports src/ functions; a user runs `npm i -g @aligndottech/cli`
# and types `align`. Four layers sit between those two and none of them is
# covered by any test: the tsc output in dist/, the package.json "files" list
# (a file missing from it is missing from npm, invisible in a checkout), the
# native install step (better-sqlite3 + the optional transformers build), and
# Commander's argv parsing (ALI-422 lived exactly there - green tests, broken
# CLI). This script packs the real tarball, installs it globally into a clean
# prefix, and runs the cold no-account first-run sequence, asserting exit codes.
#
# It proves nothing about whether the output is USEFUL - that is what human
# testers are for. It proves the sequence a cold user types does not crash.
#
# Run locally:  npm run build && bash scripts/smoke-install.sh
# CI:           the install-smoke matrix job (3 OS x 3 Node versions).
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMEOUT="node $SCRIPT_DIR/smoke-timeout.mjs"

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
# Fixture repo: a cold user's project. Three commits with decision-shaped
# messages so `import git` has something real to extract.
# ---------------------------------------------------------------------------
FIXTURE="$SMOKE_TMP/project"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q -b main
echo "# demo" > "$FIXTURE/README.md"
git -C "$FIXTURE" add README.md
git -C "$FIXTURE" commit -qm "chore: initial commit"
echo "db=postgres" > "$FIXTURE/config.ini"
git -C "$FIXTURE" add config.ini
git -C "$FIXTURE" commit -qm "feat: use Postgres over SQLite for the main store because we need concurrent writers"
echo "retries=3" >> "$FIXTURE/config.ini"
git -C "$FIXTURE" add config.ini
git -C "$FIXTURE" commit -qm "fix: decided to cap retries at 3 instead of infinite backoff to bound queue latency"

# ---------------------------------------------------------------------------
# The cold sequence. Each step: bounded by a portable timeout, exit code read
# directly, failure names the step. No || fallbacks - a hang or a crash must
# be loud (verification.md, "the defaulting fallback").
# ---------------------------------------------------------------------------
FAILURES=0
step() { # <name> <timeout-s> <cmd...>
  local name="$1" secs="$2"; shift 2
  echo ""
  echo "== $name =="
  $TIMEOUT "$secs" "$@"
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "PASS: $name"
  else
    echo "FAIL: $name (exit $rc$([ $rc -eq 124 ] && echo ' = TIMED OUT / HUNG'))"
    FAILURES=$((FAILURES + 1))
  fi
  return 0
}

cd "$FIXTURE"

step "align --version"          30  align --version
step "align --help"             30  align --help
# setup --local: the no-account path. stdin is closed by the timeout runner, so
# this also asserts the connector multiselect cancels cleanly instead of hanging
# (it has no --approve bypass). First import downloads the ~90MB embedding
# model - the long timeout is the download, not the work.
step "align setup --local"      600 align setup --local
step "align import git"         300 align import git --approve --env local --limit 20
step "align local status"       60  align local status
step "align search (local)"     120 align search "postgres" --env local --limit 5
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
step "align ask (local, no key)" 120 align ask postgres --env local --limit 5
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
if [ "$ADVISORY_RC" -ne 0 ]; then
  echo "FAIL: advisory hook exited $ADVISORY_RC$([ "$ADVISORY_RC" -eq 124 ] && echo ' = TIMED OUT / HUNG')"
  FAILURES=$((FAILURES + 1))
elif printf '%s' "$ADVISORY_OUT" | grep -q "NOT been adjudicated"; then
  echo "PASS: advisory hook surfaced related decisions, retrieval-only, with no provider key"
else
  echo "FAIL: advisory hook did not take the retrieval path (exit 0). Got: ${ADVISORY_OUT:-<no output>}"
  FAILURES=$((FAILURES + 1))
fi
step "align mcp --setup"        60  align mcp --setup --env local
# Bare name, not $ALIGN_BIN: the handshake helper spawns through cmd.exe on
# Windows, and cmd resolves `align` -> align.cmd via PATH + PATHEXT, while the
# full POSIX-style path to the sh shim is unrunnable there.
step "MCP handshake"            60  node "$SCRIPT_DIR/smoke-mcp-handshake.mjs" align

rm -f "$TARBALL"

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "SMOKE RESULT: $FAILURES step(s) failed"
  exit 1
fi
echo "SMOKE RESULT: all steps passed"
