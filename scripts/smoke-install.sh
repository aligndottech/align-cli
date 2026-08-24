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
