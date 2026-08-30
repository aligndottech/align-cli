#!/usr/bin/env bash
# Binary smoke: prove the COMPILED artifact opens a real local graph (ALI-740).
#
# WHY THIS IS A SEPARATE SUITE FROM smoke-install.sh
# --------------------------------------------------
# That one becomes the user of the npm package. This one asserts the handful of
# claims that are true only of a compiled binary, and every one of them was false
# on the first build:
#
#   1. It runs with no Node, no npm and no node_modules anywhere.
#   2. It opens the local SQLite graph. This is the whole point. `align --version`
#      exits 0 on a binary whose FIRST DB call dies, so a version check is a false
#      green and was believed once already:
#        error: Could not find module root given file: "/$bunfs/root/align"
#           at bindings -> new Database -> createLocalDb
#   3. The artifact under test is the one just built, not a stale one on PATH.
#
# The gate this really defends is a Bun upgrade. `better-sqlite3` failed here on a
# NODE_MODULE_VERSION mismatch against Bun's bundled Node; `node:sqlite` has no such
# coupling, and this is what would notice if that ever stopped being true.
#
# Run locally:  bash scripts/build-binaries.sh linux-x64 && bash scripts/smoke-binary.sh
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Which binary. Preconditions are FATAL, never test failures: a missing subject
# satisfies any exit-code assertion for the wrong reason.
# ---------------------------------------------------------------------------
host_asset() {
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) echo "FATAL: unsupported OS $(uname -s)" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "FATAL: unsupported arch $(uname -m)" >&2; return 1 ;;
  esac
  # musl (Alpine) needs the musl build; ldd naming it is the cheapest reliable tell.
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    echo "align-$os-$arch-musl"
  elif [ "$os" = windows ]; then
    echo "align-$os-$arch.exe"
  else
    echo "align-$os-$arch"
  fi
}

ASSET="${ALIGN_SMOKE_BINARY_ASSET:-$(host_asset)}" || exit 1
BIN="${ALIGN_SMOKE_BINARY:-$REPO_ROOT/dist-bin/$ASSET}"

[ -f "$BIN" ] || { echo "FATAL: $BIN does not exist - run 'bash scripts/build-binaries.sh' first"; exit 1; }
[ -x "$BIN" ] || chmod +x "$BIN" 2>/dev/null || true
command -v node >/dev/null || { echo "FATAL: node not on PATH (needed to read the DB back independently)"; exit 1; }

FAILURES=0
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS: $1"; }

# ---------------------------------------------------------------------------
# Isolate. The CLI writes config via env-paths, so without this a local run
# clobbers the developer's real graph.
# ---------------------------------------------------------------------------
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME"
export HOME="$FAKE_HOME" USERPROFILE="$FAKE_HOME"
export APPDATA="$FAKE_HOME/AppData/Roaming" LOCALAPPDATA="$FAKE_HOME/AppData/Local"
export XDG_CONFIG_HOME="$FAKE_HOME/.config" XDG_DATA_HOME="$FAKE_HOME/.local/share"
export XDG_CACHE_HOME="$FAKE_HOME/.cache"
mkdir -p "$APPDATA" "$LOCALAPPDATA" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

echo "binary under test: $BIN ($(wc -c < "$BIN" | tr -d ' ') bytes)"

# ---------------------------------------------------------------------------
# 1. It is the artifact we just built.
#
# Comparing to package.json rather than asserting "prints something": a stale
# binary left in dist-bin/ from an earlier version passes every check below and
# tells you nothing about the code under review.
# ---------------------------------------------------------------------------
EXPECTED_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
ACTUAL_VERSION="$("$BIN" --version 2>&1 | tr -d '\r\n ')"
if [ "$ACTUAL_VERSION" = "$EXPECTED_VERSION" ]; then
  pass "--version is $ACTUAL_VERSION, matching package.json"
else
  fail "--version printed '$ACTUAL_VERSION', package.json says '$EXPECTED_VERSION' (stale binary?)"
fi

# ---------------------------------------------------------------------------
# 2. It opens the local graph, run from a directory with no node_modules.
#
# `cd "$TMP"` is load-bearing: run from the repo root, a broken binary could still
# resolve something out of ./node_modules and pass.
# ---------------------------------------------------------------------------
cd "$TMP"
START_OUT="$("$BIN" local start 2>&1)"; START_RC=$?
printf '%s\n' "$START_OUT" | sed 's/^/  | /'
[ $START_RC -eq 0 ] || fail "local start exited $START_RC"

# The claim is the FILE, not the command's own report of success. A tool reporting
# its own success is not verification of its effect.
DB="$(find "$FAKE_HOME" -name 'local.db' -type f 2>/dev/null | head -1)"
if [ -z "$DB" ]; then
  fail "local start exited 0 but wrote no local.db anywhere under HOME"
else
  pass "local.db written at $DB"

  # Read it back with a DIFFERENT reader than the one that wrote it. node:sqlite here
  # is the same engine, but a separate process with no CLI code in it, so this asserts
  # the bytes on disk are a real database rather than trusting the writer.
  SCHEMA_JSON="$(node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    // The sqlite_% filter is applied in JS, not in SQL: this whole program is inside a
    // single-quoted shell string, so a SQL string literal cannot be written here, and
    // "sqlite_%" in SQL is an IDENTIFIER - which is an ERR_SQLITE_ERROR, not a filter.
    const names = (t) => db.prepare(
      "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name"
    ).all(t).map(r => r.name).filter(n => !n.startsWith("sqlite_"));
    process.stdout.write(JSON.stringify({
      tables: names("table"),
      indexes: names("index"),
      userVersion: db.prepare("PRAGMA user_version").get().user_version,
    }));
  ' "$DB" 2>&1)" || { fail "could not read $DB back as SQLite: $SCHEMA_JSON"; SCHEMA_JSON=""; }

  if [ -n "$SCHEMA_JSON" ]; then
    echo "  schema: $SCHEMA_JSON"
    # Each table asserted BY NAME, not as a count. A count passes while the one table
    # that matters is missing, and names the gap when it fails.
    for t in decisions decision_links decision_embeddings; do
      case "$SCHEMA_JSON" in
        *"\"$t\""*) pass "table $t present" ;;
        *) fail "table $t missing from the DB the binary created" ;;
      esac
    done
    # The migration ran, not just the schema. user_version is stamped only by migrate().
    case "$SCHEMA_JSON" in
      *'"userVersion":0'*) fail "user_version is 0 - schema created but migrate() did not run" ;;
      *'"userVersion":'*)  pass "migrate() ran (user_version stamped)" ;;
    esac
    # The unique indexes are created INSIDE the v2 migration's transaction, so their
    # presence is the tell that it committed rather than rolled back.
    for i in decisions_source_title_unique decision_links_triple_unique; do
      case "$SCHEMA_JSON" in
        *"\"$i\""*) pass "index $i present" ;;
        *) fail "index $i missing - the v2 migration did not commit" ;;
      esac
    done
  fi
fi

# ---------------------------------------------------------------------------
# 3. It reads the graph back through the CLI's own path.
# ---------------------------------------------------------------------------
STATUS_OUT="$("$BIN" local status 2>&1)"; STATUS_RC=$?
printf '%s\n' "$STATUS_OUT" | sed 's/^/  | /'
if [ $STATUS_RC -ne 0 ]; then
  fail "local status exited $STATUS_RC"
elif printf '%s' "$STATUS_OUT" | grep -q "decisions in your graph"; then
  pass "local status read the graph"
else
  fail "local status exited 0 without reporting a decision count - did it reach the DB?"
fi

# ---------------------------------------------------------------------------
# 4. The failure that must NOT reappear.
#
# A negative assertion needs a positive control, or it passes in an empty world.
# The control is above: the schema checks can only pass if SQLite really opened.
# With that established, the absence of this string is meaningful.
# ---------------------------------------------------------------------------
ALL_OUT="$START_OUT
$STATUS_OUT"
if printf '%s' "$ALL_OUT" | grep -qi "could not find module root\|Cannot find package\|NODE_MODULE_VERSION"; then
  fail "the binary hit a module-resolution or native-ABI error - a native dependency is back"
else
  pass "no module-resolution or native-ABI error in any step"
fi

# ---------------------------------------------------------------------------
# 5. It knows it is a binary.
#
# src/lib/distribution.ts reads a build-time --define, and vitest can never see that
# define - so this is the ONLY place the 'binary' branch is actually exercised. Under
# npm the same path prints "reinstall on a supported platform", which is advice a
# binary user cannot follow (there is no package for them to reinstall).
#
# Asserted through the real embedding path rather than by adding a debug flag, because
# the message is the deliverable and a flag would test the flag.
# ---------------------------------------------------------------------------
ASK_OUT="$("$BIN" ask something --env local --limit 1 2>&1)"
printf '%s\n' "$ASK_OUT" | sed 's/^/  | /'
if printf '%s' "$ASK_OUT" | grep -qi "standalone binary does not yet carry"; then
  pass "the embedding path reports the binary-specific message"
elif printf '%s' "$ASK_OUT" | grep -qi "reinstall on a supported platform"; then
  fail "the binary printed the NPM advice - --define __ALIGN_DIST__ did not reach the build"
else
  # Not a failure: if a future build does carry the embedding runtime, this path
  # succeeds and there is no message to find. Say which case happened rather than
  # asserting an absence that both outcomes satisfy.
  echo "NOTE: no distribution-specific embedding message in this output - either the"
  echo "      embedding runtime is now present, or the command did not reach that path."
fi

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "BINARY SMOKE RESULT: $FAILURES check(s) failed"
  exit 1
fi
echo "BINARY SMOKE RESULT: all checks passed"
