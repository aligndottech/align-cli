#!/usr/bin/env bash
# install.sh and build-binaries.sh are TWO WRITERS OF ONE FACT: the asset names.
#
# build-binaries.sh decides what gets uploaded. install.sh decides what gets asked for.
# Nothing connects them, they are in different languages, and a rename on either side
# breaks every install line at once - with no error until a stranger runs the command
# from the README and gets a 404. That is the class of defect this repo has already paid
# for elsewhere (code-style.md, "a type and a database constraint are two writers").
#
# So: derive both sets and compare them. Also exercise install.sh end to end against a
# local file:// release, including a checksum mismatch, because "it downloaded something"
# and "it verified what it downloaded" are different claims.
#
# Run: bash scripts/__tests__/test-install-assets.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_SH="$ROOT/install.sh"
BUILD_SH="$ROOT/scripts/build-binaries.sh"

[ -f "$INSTALL_SH" ] || { echo "FATAL: $INSTALL_SH missing"; exit 1; }
[ -f "$BUILD_SH" ]   || { echo "FATAL: $BUILD_SH missing"; exit 1; }

FAILURES=0
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS: $1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# ---------------------------------------------------------------------------
# The set build-binaries.sh produces, read out of its TARGETS table.
# A zero-match parse RAISES - an empty expected-set would make every comparison
# below pass vacuously (verification.md, "make a zero-match parse raise").
# ---------------------------------------------------------------------------
BUILT="$(awk '/^TARGETS="/{f=1;next} /^"$/{f=0} f && /:/{split($0,a,":"); print a[1]}' "$BUILD_SH")"
BUILT_COUNT="$(printf '%s\n' "$BUILT" | grep -c .)"
if [ "$BUILT_COUNT" -lt 4 ]; then
  echo "FATAL: parsed only $BUILT_COUNT targets out of build-binaries.sh - the parse is broken,"
  echo "       not the script. Refusing to report a comparison against an empty set."
  exit 1
fi
pass "parsed $BUILT_COUNT targets from build-binaries.sh"

# Full asset filenames, mirroring build-binaries.sh's .exe rule.
built_assets() {
  printf '%s\n' "$BUILT" | while read -r n; do
    [ -n "$n" ] || continue
    case "$n" in windows-*) echo "align-$n.exe" ;; *) echo "align-$n" ;; esac
  done
}

# ---------------------------------------------------------------------------
# What install.sh asks for, on every platform it claims to support. uname is
# faked rather than the detection logic being re-implemented here - a second
# copy of the rule would be a third writer of the same fact.
# ---------------------------------------------------------------------------
ask_for() { # <uname-s> <uname-m> <ldd-output>
  local fake="$TMP/fakebin"; rm -rf "$fake"; mkdir -p "$fake"
  cat > "$fake/uname" <<EOF
#!/bin/sh
case "\$1" in
  -s) echo "$1" ;;
  -m) echo "$2" ;;
  *)  echo "$1" ;;
esac
EOF
  cat > "$fake/ldd" <<EOF
#!/bin/sh
echo "$3"
EOF
  chmod +x "$fake/uname" "$fake/ldd"
  PATH="$fake:$PATH" ALIGN_DRY_RUN=1 sh "$INSTALL_SH" 2>&1
}

echo ""
echo "-- every platform install.sh supports must map to a built asset --"
# Third column is what `ldd --version` prints: the musl banner or a glibc one.
while read -r sys machine ldd_out; do
  [ -n "$sys" ] || continue
  asset="$(ask_for "$sys" "$machine" "$ldd_out")"
  if built_assets | grep -qx "$asset"; then
    pass "$sys/$machine -> $asset"
  else
    fail "$sys/$machine -> '$asset', which build-binaries.sh does not produce"
  fi
done <<'PLATFORMS'
Linux x86_64 ldd_(GNU_libc)_2.39
Linux aarch64 ldd_(GNU_libc)_2.39
Linux x86_64 musl_libc_(x86_64)
Linux aarch64 musl_libc_(aarch64)
Darwin x86_64 -
Darwin arm64 -
MINGW64_NT-10.0 x86_64 -
MINGW64_NT-10.0 aarch64 -
PLATFORMS

# ---------------------------------------------------------------------------
# NEGATIVE CONTROL for the comparison itself. If `built_assets | grep -qx` matched
# anything, every row above would pass whatever install.sh said - so prove a name
# that is NOT built is rejected.
# ---------------------------------------------------------------------------
if built_assets | grep -qx "align-plan9-x64"; then
  fail "the asset comparison matches a name nothing builds - the check is broken"
else
  pass "negative control: an unbuilt asset name is not matched"
fi

echo ""
echo "-- an unsupported platform must refuse, not guess --"
out="$(ask_for "Plan9" "x86_64" "-")"
if printf '%s' "$out" | grep -q "unsupported operating system"; then
  pass "unknown OS is refused with a message naming the npm fallback"
else
  fail "unknown OS did not refuse; it said: $out"
fi
out="$(ask_for "Linux" "riscv64" "-")"
if printf '%s' "$out" | grep -q "unsupported architecture"; then
  pass "unknown arch is refused"
else
  fail "unknown arch did not refuse; it said: $out"
fi

# ---------------------------------------------------------------------------
# End to end against a local file:// release, so the download, the checksum and
# the install are exercised rather than reasoned about.
# ---------------------------------------------------------------------------
echo ""
echo "-- end to end against a local release --"
if ! command -v curl >/dev/null; then
  echo "SKIP: curl not available, cannot exercise the download path"
else
  HOST_ASSET="$(ALIGN_DRY_RUN=1 sh "$INSTALL_SH")"
  REL="$TMP/release/latest/download"; mkdir -p "$REL"
  printf '#!/bin/sh\necho 9.9.9-fixture\n' > "$REL/$HOST_ASSET"; chmod +x "$REL/$HOST_ASSET"
  ( cd "$REL" && (command -v sha256sum >/dev/null && sha256sum "$HOST_ASSET" || shasum -a 256 "$HOST_ASSET") > SHA256SUMS )

  DEST="$TMP/bin"
  if out="$(ALIGN_BASE_URL="file://$TMP/release" ALIGN_INSTALL_DIR="$DEST" sh "$INSTALL_SH" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/  | /'
    if [ -x "$DEST/align" ] && [ "$("$DEST/align" --version)" = "9.9.9-fixture" ]; then
      pass "installed the downloaded binary and it runs"
    else
      fail "install reported success but $DEST/align is missing or does not run"
    fi
    printf '%s' "$out" | grep -q "checksum verified" \
      && pass "checksum was verified" \
      || fail "install did not report verifying the checksum"
  else
    printf '%s\n' "$out" | sed 's/^/  | /'
    fail "end-to-end install against a local release failed"
  fi

  # A corrupted download MUST be refused. Without this the checksum step is
  # decoration: it would report "verified" on anything.
  printf '#!/bin/sh\necho TAMPERED\n' > "$REL/$HOST_ASSET"
  DEST2="$TMP/bin2"
  if out="$(ALIGN_BASE_URL="file://$TMP/release" ALIGN_INSTALL_DIR="$DEST2" sh "$INSTALL_SH" 2>&1)"; then
    fail "a tampered binary was INSTALLED - the checksum check does not gate anything"
  elif printf '%s' "$out" | grep -q "checksum mismatch"; then
    pass "a tampered binary is refused on checksum mismatch"
    [ -e "$DEST2/align" ] && fail "refused, but wrote $DEST2/align anyway" || pass "nothing was written on refusal"
  else
    fail "install failed on a tampered binary, but not with a checksum message: $out"
  fi
fi

echo ""
if [ "$FAILURES" -ne 0 ]; then
  echo "INSTALL ASSET TESTS: $FAILURES failed"
  exit 1
fi
echo "INSTALL ASSET TESTS: all passed"
