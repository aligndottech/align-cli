#!/bin/sh
# Align CLI installer (ALI-740).
#
#   curl -fsSL https://raw.githubusercontent.com/aligndottech/align-cli/main/install.sh | sh
#
# Downloads the standalone binary for this platform from the latest GitHub release,
# verifies its SHA-256 against the release's own SHA256SUMS file, and installs it.
#
# POSIX sh on purpose: this runs on whatever shell a stranger's machine has, before
# they have installed anything of ours. No bashisms, no arrays, no [[ ]].
#
# Overrides, all optional:
#   ALIGN_VERSION      tag to install (default: the latest release)
#   ALIGN_INSTALL_DIR  where to put the binary (default: ~/.local/bin, or /usr/local/bin
#                      when it is writable)
#   ALIGN_BASE_URL     release download base (used by the test suite)
#   ALIGN_DRY_RUN      set to 1 to print the resolved asset and exit, changing nothing
set -eu

REPO="aligndottech/align-cli"
BASE_URL="${ALIGN_BASE_URL:-https://github.com/$REPO/releases}"

die() { echo "align install: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Which asset. These names are the contract with scripts/build-binaries.sh - if
# one side is renamed and the other is not, every install line breaks at once,
# which is why the test suite pins them against each other rather than trusting
# that two lists stay in step.
# ---------------------------------------------------------------------------
detect_asset() {
  _os=""
  case "$(uname -s)" in
    Linux)                 _os=linux ;;
    Darwin)                _os=darwin ;;
    MINGW*|MSYS*|CYGWIN*)  _os=windows ;;
    *) die "unsupported operating system '$(uname -s)'. Install from npm instead: npm install -g @aligndottech/cli" ;;
  esac

  _arch=""
  case "$(uname -m)" in
    x86_64|amd64)   _arch=x64 ;;
    arm64|aarch64)  _arch=arm64 ;;
    *) die "unsupported architecture '$(uname -m)'. Install from npm instead: npm install -g @aligndottech/cli" ;;
  esac

  # Alpine and other musl systems need the musl build; the glibc one will not run.
  # `ldd --version` writes its banner to stderr on glibc and stdout on musl, so both
  # streams are read. A machine with no ldd at all is treated as glibc, which is the
  # common case and fails loudly at first run rather than silently mis-installing.
  _libc=""
  if [ "$_os" = linux ]; then
    if (ldd --version 2>&1 || true) | grep -qi musl; then
      _libc="-musl"
    fi
  fi

  if [ "$_os" = windows ]; then
    echo "align-$_os-$_arch.exe"
  else
    echo "align-$_os-$_arch$_libc"
  fi
}

ASSET="$(detect_asset)"

if [ "${ALIGN_DRY_RUN:-}" = "1" ]; then
  echo "$ASSET"
  exit 0
fi

# ---------------------------------------------------------------------------
# Which version.
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
have curl || have wget || die "neither curl nor wget is available"

fetch() { # <url> <dest>
  if have curl; then
    curl -fsSL "$1" -o "$2"
  else
    wget -qO "$2" "$1"
  fi
}

if [ -n "${ALIGN_VERSION:-}" ]; then
  DL="$BASE_URL/download/$ALIGN_VERSION"
else
  DL="$BASE_URL/latest/download"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "align install: downloading $ASSET"
fetch "$DL/$ASSET" "$TMP/$ASSET" || die "could not download $DL/$ASSET
  If this platform has no binary yet, install from npm: npm install -g @aligndottech/cli"

# ---------------------------------------------------------------------------
# Verify. A checksum we cannot check is reported, never silently skipped: "no
# sha256 tool here" and "the file is intact" must not look the same.
# ---------------------------------------------------------------------------
if fetch "$DL/SHA256SUMS" "$TMP/SHA256SUMS" 2>/dev/null; then
  EXPECTED="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}')"
  [ -n "$EXPECTED" ] || die "SHA256SUMS on the release does not list $ASSET"

  if have sha256sum;  then ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
  elif have shasum;   then ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
  else ACTUAL=""; fi

  if [ -z "$ACTUAL" ]; then
    echo "align install: WARNING - no sha256sum or shasum on this machine, checksum NOT verified" >&2
  elif [ "$ACTUAL" != "$EXPECTED" ]; then
    die "checksum mismatch for $ASSET
  expected $EXPECTED
  got      $ACTUAL
  Refusing to install. Try again, and if it repeats, open an issue."
  else
    echo "align install: checksum verified"
  fi
else
  echo "align install: WARNING - no SHA256SUMS on this release, checksum NOT verified" >&2
fi

# ---------------------------------------------------------------------------
# Install.
# ---------------------------------------------------------------------------
if [ -n "${ALIGN_INSTALL_DIR:-}" ]; then
  DEST="$ALIGN_INSTALL_DIR"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  DEST=/usr/local/bin
else
  DEST="$HOME/.local/bin"
fi
mkdir -p "$DEST" || die "could not create $DEST"

TARGET="$DEST/align"
case "$ASSET" in *.exe) TARGET="$DEST/align.exe" ;; esac

chmod +x "$TMP/$ASSET"
mv "$TMP/$ASSET" "$TARGET" || die "could not write $TARGET"

echo "align install: installed to $TARGET"

# Report what is actually runnable, rather than announcing success. An install into
# a directory not on PATH is the single most common way a working install reads as
# a broken product.
case ":$PATH:" in
  *":$DEST:"*) ;;
  *)
    echo ""
    echo "  $DEST is not on your PATH. Add it:"
    echo "    export PATH=\"$DEST:\$PATH\""
    echo ""
    ;;
esac

"$TARGET" --version >/dev/null 2>&1 || die "installed, but '$TARGET --version' did not run. Wrong build for this platform?"
echo "align install: $("$TARGET" --version) ready. Next: align setup --local"
