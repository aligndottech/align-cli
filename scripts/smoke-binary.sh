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
# The huggingface.co 429 classifier, shared with smoke-install.sh. A second copy of that
# judgement would drift from the first (code-style.md, "two writers of one fact").
# shellcheck source=smoke-model.sh
. "$SCRIPT_DIR/smoke-model.sh"

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
SKIPPED=0
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

# Where the ~23MB model is cached BETWEEN runs. The isolation above puts the default cache
# inside a temp dir that dies with the job, so without this every CI run re-downloads it and
# the gate depends on huggingface.co being reachable and unthrottled. A relative value is
# resolved against the repo root, so a Windows D:\a\... path never has to survive Git Bash.
# Unset (the default) means cold, which is the local-developer behaviour.
SMOKE_MODEL_CACHE="${ALIGN_SMOKE_MODEL_CACHE:-}"
if [ -n "$SMOKE_MODEL_CACHE" ]; then
  case "$SMOKE_MODEL_CACHE" in
    /*|[A-Za-z]:[\\/]*) ;;
    *) SMOKE_MODEL_CACHE="$REPO_ROOT/$SMOKE_MODEL_CACHE" ;;
  esac
  mkdir -p "$SMOKE_MODEL_CACHE"
  export ALIGN_MODEL_CACHE="$SMOKE_MODEL_CACHE"
  if [ -n "$(ls -A "$SMOKE_MODEL_CACHE" 2>/dev/null)" ]; then
    echo "model cache: WARM - $SMOKE_MODEL_CACHE has content, no download expected"
  else
    echo "model cache: COLD - $SMOKE_MODEL_CACHE is empty, downloading from huggingface.co"
  fi
else
  echo "model cache: COLD - ALIGN_SMOKE_MODEL_CACHE unset, downloading from huggingface.co"
fi

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
# 5. ON-DEVICE EMBEDDINGS, in the binary. The reason ALI-744 exists.
#
# This is the claim nothing else can make: vitest never sees the `--define` that selects
# the WASM backend, and never sees the embedded ORT assets, so a compiled artifact is the
# only place the backend can be exercised at all.
#
# Driven end to end (import writes vectors, search reads them back) rather than by calling
# an embedding helper, because the failure this guards against is structural - a binary
# built from the wrong entry point registers no backend and every one of these steps still
# exits 0 having embedded nothing.
#
# The one-time ~23MB model download from huggingface.co happens here. A 429 from a shared
# runner IP is upstream and reports SKIP; every other failure is ours. Same rule, and the
# same classifier, as smoke-install.sh.
# ---------------------------------------------------------------------------
FIXTURE="$TMP/project"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q -b main
git -C "$FIXTURE" config user.email smoke@example.invalid
git -C "$FIXTURE" config user.name "Smoke Tester"
echo "db=postgres" > "$FIXTURE/config.ini"
git -C "$FIXTURE" add config.ini
git -C "$FIXTURE" commit -qm "feat: use Postgres over SQLite for the main store because we need concurrent writers"
echo "retries=3" >> "$FIXTURE/config.ini"
git -C "$FIXTURE" add config.ini
git -C "$FIXTURE" commit -qm "fix: decided to cap retries at 3 instead of infinite backoff to bound queue latency"

cd "$FIXTURE"
echo ""
echo "== import git (downloads the model on a cold cache, then embeds) =="
IMPORT_OUT="$("$BIN" import git --approve --env local --limit 20 2>&1)"; IMPORT_RC=$?
printf '%s\n' "$IMPORT_OUT" | sed 's/^/  | /'
IMPORT_VERDICT="$(classify_step_result "$IMPORT_RC" "$IMPORT_OUT")"

if [ "$IMPORT_VERDICT" = skip-upstream ]; then
  SKIPPED=$((SKIPPED + 1))
  echo "SKIP: import git - huggingface.co returned HTTP 429 for the model download."
  echo "      Upstream rate limiting of a shared runner IP, not attributable to this change."
  echo "::warning title=Embedding model download rate-limited (429)::The binary embedding smoke was skipped: huggingface.co rate-limited the ~23MB model download. Upstream, not this change - re-run the job."
elif [ "$IMPORT_VERDICT" != pass ]; then
  fail "import git exited $IMPORT_RC in the binary"
else
  # An import that exits 0 having imported nothing is an assertion that cannot fail.
  if printf '%s' "$IMPORT_OUT" | grep -qE '[0-9]+ batch(es)? failed'; then
    fail "import git exited 0 but reported a failed batch - embeddings did not run"
  else
    pass "import git completed with no failed batch"
  fi

  # The EFFECT: vectors on disk. `decision_embeddings` is written only by setEmbedding,
  # which only runs once getEmbedding has returned - so a non-zero count here is proof the
  # WASM backend actually produced vectors, not merely that a command exited 0.
  EMB="$(node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    process.stdout.write(String(db.prepare("SELECT COUNT(*) n FROM decision_embeddings").get().n));
  ' "$DB" 2>&1)" || EMB="err"
  if [ "$EMB" = "err" ] || [ -z "$EMB" ]; then
    fail "could not count rows in decision_embeddings"
  elif [ "$EMB" -gt 0 ] 2>/dev/null; then
    pass "the binary wrote $EMB embedding vector(s) on device"
  else
    fail "0 embedding vectors after a successful import - the WASM backend produced nothing"
  fi

  # And that they are usable: search ranks on cosine over those vectors.
  SEARCH_OUT="$("$BIN" search "postgres" --env local --limit 5 2>&1)"; SEARCH_RC=$?
  printf '%s\n' "$SEARCH_OUT" | sed 's/^/  | /'
  if [ $SEARCH_RC -ne 0 ]; then
    fail "search exited $SEARCH_RC"
  elif printf '%s' "$SEARCH_OUT" | grep -qi "postgres"; then
    pass "search retrieved a decision through on-device similarity"
  else
    fail "search exited 0 but returned nothing for a term that is in the graph"
  fi

  # The npm-shaped advice must never appear in a binary: it tells the user to reinstall a
  # package they never installed. Meaningful as an absence only because the checks above
  # established the path really ran.
  if printf '%s\n%s' "$IMPORT_OUT" "$SEARCH_OUT" | grep -qi "reinstall on a supported platform"; then
    fail "the binary printed the npm advice - the WASM backend was not registered"
  else
    pass "no npm-shaped advice in the binary's output"
  fi
fi

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "BINARY SMOKE RESULT: $FAILURES check(s) failed, $SKIPPED skipped upstream"
  exit 1
fi
if [ "$SKIPPED" -ne 0 ]; then
  # Same narrow, loud exception as smoke-install.sh: a huggingface.co 429 on a shared runner
  # IP is not attributable to this change, and a red nobody can act on teaches people to
  # ignore red. Everything except the model download stays unconditionally ours.
  echo "BINARY SMOKE RESULT: all checks passed except $SKIPPED skipped for an upstream huggingface.co 429"
  exit 0
fi
echo "BINARY SMOKE RESULT: all checks passed"
