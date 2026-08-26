#!/usr/bin/env bash
# Assemble the publishable copy of this action for aligndottech/decision-check.
#
# The action is authored here, next to decide.sh's truth table and the shell-syntax gate,
# but it is CONSUMED from a repo root: GitHub Marketplace requires action.yml at the root
# of a repository, so an action living in .github/actions/ can never be listed (ALI-686).
# The published repo is therefore a mirror of this directory.
#
# This is a script rather than inline workflow steps so the transformation is testable.
# The last mirror-shaped thing here shipped a stray `esac` that no structural check could
# see, and a sed that silently matches nothing looks exactly like a sed that worked.
#
# Usage: mirror.sh <dest-dir> <ref>
#   ref is what the README's `uses:` lines should point at, e.g. v2
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:?usage: mirror.sh <dest-dir> <ref>}"
REF="${2:?usage: mirror.sh <dest-dir> <ref>}"

mkdir -p "$DEST"
# The four files that make up the action. annotate.mjs and decide.sh are resolved at
# runtime through ${{ github.action_path }}, so they work unchanged at a repo root.
FILES=(action.yml decide.sh annotate.mjs README.md)

for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "mirror.sh: missing source file $f" >&2; exit 1; }
  cp "$SRC/$f" "$DEST/$f"
done
chmod +x "$DEST/decide.sh"

# Point the README's examples at the published repo instead of the subdirectory path
# nobody outside this repo should use. Count first: a rewrite that matches nothing exits
# 0 and leaves a README telling strangers to depend on a path that cannot be Marketplace
# listed, which reads exactly like success.
SELF='aligndottech/align-cli/.github/actions/align-check@main'
BEFORE=$(grep -c "$SELF" "$DEST/README.md" || true)
if [ "$BEFORE" -eq 0 ]; then
  echo "mirror.sh: found no '$SELF' references to rewrite - did the README change?" >&2
  exit 1
fi
perl -pi -e "s{\Q$SELF\E}{aligndottech/decision-check\@$REF}g" "$DEST/README.md"
AFTER=$(grep -c "$SELF" "$DEST/README.md" || true)
if [ "$AFTER" -ne 0 ]; then
  echo "mirror.sh: $AFTER reference(s) survived the rewrite" >&2
  exit 1
fi
echo "mirror.sh: rewrote $BEFORE reference(s) to aligndottech/decision-check@$REF"

# MIT, and shipped rather than assumed. The published repo carried NO licence at all until
# ALI-686, which under default copyright makes a Marketplace action legally unusable by any
# organisation with a licence policy - the opposite of a distribution channel.
cat > "$DEST/LICENSE" <<'EOF'
MIT License

Copyright (c) 2026 Align Tech Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF

echo "mirror.sh: assembled $((${#FILES[@]} + 1)) files in $DEST"
