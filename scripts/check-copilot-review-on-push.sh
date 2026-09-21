#!/usr/bin/env bash
# ALI-1170: the `copilot_code_review` rule must have `review_on_push: true`.
#
# WHAT WENT WRONG. The branch ruleset carried a `copilot_code_review` rule, which reads as
# "Copilot must have reviewed this before it merges". It does not mean that. Its parameters
# were `{"review_draft_pull_requests": false, "review_on_push": false}`, so Copilot reviewed
# once when a PR opened and never again. Every fix commit therefore merged unreviewed,
# because a fix is a push.
#
# Measured on 2026-09-21: align-stack#2541 merged at 17:31:20Z with head ff2a4716c while the
# last review was of 8f261746c at 16:42:45Z - 49 minutes and one commit stale. A whole
# afternoon's batch was in that state, and the review discipline around it looked like it was
# working the entire time.
#
# The field was flipped to `true` that evening. THIS GUARD EXISTS BECAUSE NOTHING ELSE WOULD
# NOTICE IF IT FLIPPED BACK. A ruleset is edited in a web UI, by a human, with no diff and no
# review, and the only symptom of a regression is another batch merging unreviewed - which is
# exactly the symptom nobody spotted the first time. A control that is only ever stated
# drifts, and it drifts furthest where nobody is looking.
#
# WHY IT ASSERTS THE RULE EXISTS BEFORE ASSERTING ITS VALUE. Deleting the rule outright is a
# bigger regression than flipping its field, and a naive value check finds nothing to compare
# and reports no violations. That is the defaulting-fallback shape, and it would be a poor
# place for it: a guard that silently does nothing, on a ticket about a control that silently
# did nothing.
#
# WHY jq AND NOT grep. Measured: `grep -o '"review_on_push":[a-z]*'` over a raw `curl`
# response matches the KEY and not the value, because a space follows the colon there. The
# same grep against `gh api` output returns the value, because the two clients format JSON
# differently. So that regex passes or fails depending on which client fetched it, which is
# the shape that works on a laptop and matches nothing in CI.
#
# IT NEEDS THE NETWORK, so it can fail for reasons that have nothing to do with the
# invariant: no token, no jq, an API error, a scope change. Every one of those FAILS,
# deliberately - "I could not look" is not "the setting is fine" - but each prints a different
# message, so whoever is debugging is not sent after a ruleset that was never wrong. That
# property is what makes the placement below a real decision rather than a detail.
#
# PORTED FROM align-stack (ALI-1170) UNDER ALI-1185, AND IT CURRENTLY FAILS HERE ON PURPOSE.
#
# align-stack found that its `copilot_code_review` rule had `review_on_push: false`, so
# Copilot reviewed a PR once at open and never again, and every commit addressing a review
# merged unreviewed. That was fixed on align-stack's ruleset. **A ruleset is per-repo**, and
# nobody checked this one until ALI-1185. Read from the API on 2026-09-21:
#
#   align-cli ruleset 20917995   copilot_code_review   review_on_push: FALSE
#
# So on this repo, right now, this guard FAILS. That is the correct result and not a broken
# check. It was demonstrated live on align-cli#314, the Windows MCP spawn fix a Kentico
# engineer hits in their first ten minutes: its review sat on a commit four commits behind the
# head, reporting two findings that described code no longer on the branch. Both had been
# addressed. The PR misreported itself in both directions at once - it read as unresolved work
# when the truth was addressed work and an unreviewed head.
#
# A push does not trigger a re-review here, and a REST re-request does not either: measured,
# 31 minutes after the call with no result, on a repo where push provably triggers nothing.
# So a finding stays Open against a stale commit until a human clicks.
#
# WIRED AS ADVISORY, DELIBERATELY. A required check that is red on every PR blocks all work
# for a reason nobody can fix from the log, which is the manufactured-alarm shape align-stack's
# own drift workflow warns about. It reports, loudly, until the ruleset is fixed - and the fix
# is a repo configuration change that needs a human with authority over this repo, not a
# session. **Do not "fix" the red by deleting this guard.** The red IS the finding.
#
# Promote it to required in the same change that flips the field, and not before: a guard that
# passes only because nothing checks it is the defect it exists to catch.
#
set -euo pipefail

REPO="${GUARD_REPO:-aligndottech/align-cli}"
BRANCH="${GUARD_BRANCH:-main}"

# A fixture path makes the test suite hermetic. Repo Guards is bash-only and must not depend
# on the network to prove its own guards work - the same split performance.md draws between
# the bundle check and the fixtures that prove the bundle check still fails loudly.
FIXTURE="${1:-${COPILOT_RULESET_FIXTURE:-}}"

die() { echo "$*" >&2; exit 1; }

if ! command -v jq >/dev/null 2>&1; then
  die "FATAL: jq is not installed, so this guard cannot parse the ruleset.
A missing tool must not read as 'no violations found' - refusing to report clean.
Install jq, or run this with a fixture path to check the parser alone."
fi

if [ -n "$FIXTURE" ]; then
  [ -f "$FIXTURE" ] || die "FATAL: fixture '$FIXTURE' does not exist."
  rules_json=$(cat "$FIXTURE")
else
  TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  [ -n "$TOKEN" ] || die "FATAL: no GH_TOKEN or GITHUB_TOKEN, so the ruleset cannot be read.
Refusing to report clean on a control this guard exists to prove is still on."

  # GUARD_CURL is a test seam, not a configuration knob. Without it every test drives the
  # fixture path, so a wrong URL, a missing header or broken ref_name filtering leaves the
  # whole suite green - the live run in a PR body is manual and cannot stop a regression.
  CURL="${GUARD_CURL:-curl}"
  API_BASE="${GUARD_API_BASE:-https://api.github.com}"

  # Bounded, because this step is in a REQUIRED job. An api.github.com that accepts the
  # connection and then stops responding would otherwise hang until the job timeout, and a
  # job killed at its deadline reports nothing useful - the one thing this guard is built to
  # avoid is failing in a way that does not say why.
  api() {
    "$CURL" -sS --fail-with-body --connect-timeout 10 --max-time 30 \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$1"
  }

  listing=$(api "$API_BASE/repos/$REPO/rulesets") \
    || die "FATAL: could not list rulesets for $REPO. That is not a pass.
If this is a permissions change, fix the permissions rather than deleting this guard."

  # Only rulesets that actually apply to the branch matter. An inactive or differently
  # targeted ruleset carrying the rule would otherwise vouch for one that does not.
  ids=$(printf '%s' "$listing" | jq -r '.[] | select(.enforcement == "active") | .id')
  [ -n "$ids" ] || die "FATAL: no ACTIVE ruleset on $REPO.
Either enforcement was turned off, which is a bigger regression than the one this checks,
or the token cannot see rulesets. Both are failures."

  rules_json="[]"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    detail=$(api "$API_BASE/repos/$REPO/rulesets/$id") \
      || die "FATAL: could not read ruleset $id. Refusing to report clean."
    applies=$(printf '%s' "$detail" \
      | jq -r --arg b "$BRANCH" '
          (.conditions.ref_name.include // []) as $inc
          | if ($inc | index("~DEFAULT_BRANCH")) or ($inc | index("refs/heads/" + $b)) or ($inc | index("~ALL"))
            then "yes" else "no" end')
    [ "$applies" = "yes" ] || continue
    rules_json=$(jq -s '.[0] + (.[1].rules // [])' <(printf '%s' "$rules_json") <(printf '%s' "$detail"))
  done <<< "$ids"
fi

count=$(printf '%s' "$rules_json" | jq '[.[] | select(.type == "copilot_code_review")] | length')

if [ "$count" -eq 0 ]; then
  die "FAIL: no copilot_code_review rule applies to '$BRANCH' on $REPO.
The rule was deleted or retargeted. Copilot then reviews nothing, and the only symptom is
PRs merging without a review having examined them - which is what ALI-1170 was filed for.
Restore the rule in the branch ruleset with review_on_push enabled."
fi

bad=$(printf '%s' "$rules_json" \
  | jq -r '[.[] | select(.type == "copilot_code_review") | select(.parameters.review_on_push != true)] | length')

if [ "$bad" -ne 0 ]; then
  actual=$(printf '%s' "$rules_json" \
    | jq -r '[.[] | select(.type == "copilot_code_review") | .parameters.review_on_push | tostring] | join(", ")')
  die "FAIL: copilot_code_review has review_on_push = $actual, expected true.
With it off, Copilot reviews a PR once when it opens and never again, so every commit
that addresses a review merges unreviewed. Measured on #2541: merged with a head the
reviewer had never seen, 49 minutes and one commit stale, with nothing reporting a gap.
Turn review_on_push back on in the branch ruleset for $REPO."
fi

echo "check-copilot-review-on-push: ok - copilot_code_review applies to '$BRANCH' with review_on_push=true"
