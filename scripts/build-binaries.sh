#!/usr/bin/env bash
# Compile the CLI to standalone binaries, one per supported platform (ALI-740).
#
# WHY THIS EXISTS
# ---------------
# `npm install -g @aligndottech/cli` needs a Node toolchain on the tester's machine.
# A single binary needs nothing. That was the first piece of feedback from an outside
# tester, and it is the normal expectation for a CLI.
#
# WHY ONE RUNNER BUILDS ALL OF THEM
# ---------------------------------
# Because there is no native addon left. `local-db.ts` used `better-sqlite3`, whose
# `.node` is resolved through `bindings` - which walks up looking for a package.json
# and finds none inside a compiled binary:
#
#     error: Could not find module root given file: "/$bunfs/root/align"
#        at bindings -> new Database -> createLocalDb
#
# Importing the `.node` statically DOES embed it, and then fails on ABI
# (NODE_MODULE_VERSION 137 vs Bun's 147), which would pin our releases to Bun's
# internal Node version and force a per-platform build matrix. ALI-740 moved the
# local graph to `node:sqlite` instead, which is built into both Node and Bun. So
# cross-compilation works, and this script is the whole build.
#
# Usage:
#   bash scripts/build-binaries.sh            # every target, into dist-bin/
#   bash scripts/build-binaries.sh linux-x64  # one target, for a quick local check
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist-bin"

# Preconditions are FATAL. A missing toolchain must not look like a clean build of
# nothing (tdd.md, "assert the subject ran").
command -v bun >/dev/null || {
  echo "FATAL: bun is not on PATH. Install it: https://bun.sh"; exit 1;
}
[ -f "$REPO_ROOT/src/index.ts" ] || { echo "FATAL: src/index.ts missing"; exit 1; }

# The asset name a user downloads, mapped to the bun --target that produces it.
# Keep the left column stable: install.sh computes it from `uname` and any rename
# here silently breaks every existing install line.
TARGETS="
linux-x64:bun-linux-x64
linux-arm64:bun-linux-arm64
linux-x64-musl:bun-linux-x64-musl
linux-arm64-musl:bun-linux-arm64-musl
darwin-x64:bun-darwin-x64
darwin-arm64:bun-darwin-arm64
windows-x64:bun-windows-x64
windows-arm64:bun-windows-arm64
"

WANTED="${1:-}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

built=0
for row in $TARGETS; do
  name="${row%%:*}"
  target="${row##*:}"
  [ -n "$WANTED" ] && [ "$WANTED" != "$name" ] && continue

  ext=""
  case "$name" in windows-*) ext=".exe" ;; esac
  outfile="$OUT_DIR/align-$name$ext"

  echo "== $name ($target) =="
  # --bytecode moves parse cost from every startup to build time. Not applied to the
  # windows targets: it is the least exercised combination here and a slower start is
  # a better failure than a binary that will not run.
  extra=""
  case "$name" in windows-*) ;; *) extra="--bytecode" ;; esac

  # --define is what makes src/lib/distribution.ts answer "binary". It is a build-time
  # fact, so the CLI never has to sniff its own runtime to work out how it was shipped.
  # Absent (a plain `bun build`, or tsc for npm) it defaults to "npm", so a forgotten
  # define degrades to the npm message rather than to a crash.
  # shellcheck disable=SC2086
  bun build --compile --target="$target" $extra \
    --define '__ALIGN_DIST__="binary"' \
    "$REPO_ROOT/src/index.ts" --outfile "$outfile"

  [ -f "$outfile" ] || { echo "FATAL: bun reported success but $outfile does not exist"; exit 1; }
  built=$((built + 1))
done

# A build that matched no target must fail rather than leave an empty dist-bin/ that
# reads like success (verification.md, "make a zero-match parse raise").
if [ "$built" -eq 0 ]; then
  echo "FATAL: no target matched '${WANTED}'. Known targets:"
  for row in $TARGETS; do echo "  ${row%%:*}"; done
  exit 1
fi

# Checksums, so a downloader can verify what they got. Written from inside the
# directory so the file names in it are bare, which is what `shasum -c` expects.
( cd "$OUT_DIR" && (command -v sha256sum >/dev/null && sha256sum align-* || shasum -a 256 align-*) > SHA256SUMS )

echo ""
echo "built $built binaries into dist-bin/"
ls -lh "$OUT_DIR" | tail -n +2 | awk '{printf "  %-28s %s\n", $9, $5}'
