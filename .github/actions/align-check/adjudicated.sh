#!/usr/bin/env bash
# Does a named human's answer already cover this exact result? (ALI-710)
#
# decide.sh owns the policy and is deliberately untouched by this: under
# fail-on: conflict-or-unknown it fails every incomplete result, which is correct and is what
# makes an unavailable control a red build rather than a silent green.
#
# But two kinds of incomplete hide under that one word. A timeout is remedied by re-running.
# A NON-VERDICT is not: the judge ran and honestly abstained, so the answer is a pure function
# of the diff and the graph and every re-run returns it again. Before this, the only ways out
# were a repo-admin bypass or weakening the policy for everyone - neither of which a customer
# has, and the first of which leaves no record.
#
# So this reads one thing off the check's own JSON: whether the gateway found an adjudication
# a named human already recorded for THIS content. The gateway matches it on a digest it
# computes from the text it was sent, never on anything the caller asserts, so a pass here
# rests on someone having answered the actual change.
#
# Usage:  adjudicated.sh <result-json>
# Exit 0 = a human accepted it (the caller may pass), 1 = no such answer (the fail stands).
set -uo pipefail

RESULT="${1:-}"

# Absent, empty or unparseable input is NOT an acceptance. Every failure mode here has to
# land on "no answer", because the one thing this script must never do is turn a broken read
# into a green build - it is the only step in the chain that can overturn a failure.
[ -n "$RESULT" ] || { echo "adjudicated=no reason=no-result"; exit 1; }

read -r VERDICT REASON_CLASS <<EOF
$(printf '%s' "$RESULT" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    // The CLI writes one JSON object per line and may print other lines first, so take the
    // LAST parseable line rather than assuming the whole stream is the object.
    const line = raw.trim().split("\n").filter(Boolean).pop() ?? "";
    const o = JSON.parse(line);
    const v = o?.prior_adjudication?.verdict ?? "none";
    const c = o?.reason_class ?? "none";
    // Whitespace in either would break the read above; both come from closed vocabularies,
    // so anything containing it is malformed and must read as no answer.
    if (/\s/.test(v) || /\s/.test(c)) { console.log("none none"); return; }
    console.log(`${v} ${c}`);
  } catch {
    console.log("none none");
  }
});
' 2>/dev/null)
EOF

VERDICT="${VERDICT:-none}"
REASON_CLASS="${REASON_CLASS:-none}"

# Both conditions, not either. reason_class pins that this is the class a human may answer:
# an adjudication must never excuse an OUTAGE, which is what accepting it against
# reason_class=unavailable would do.
if [ "$VERDICT" = "accepted" ] && [ "$REASON_CLASS" = "non_verdict" ]; then
  echo "adjudicated=yes verdict=accepted class=$REASON_CLASS"
  exit 0
fi

# A human answering 'conflicting' is not an acceptance, and needs no branch of its own: the
# failure decide.sh already returned is the right outcome. Naming it here makes the annotation
# able to say which of the two it was.
echo "adjudicated=no verdict=$VERDICT class=$REASON_CLASS"
exit 1
