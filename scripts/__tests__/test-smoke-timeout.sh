#!/usr/bin/env bash
# Guards for scripts/smoke-timeout.mjs, the smoke matrix's portable timeout runner.
#
# It exists because no `timeout` binary is on PATH across ubuntu/macos/windows. On win32 it
# spawns with `shell: true`, because `npm i -g` exposes align as align.cmd which spawn() cannot
# exec directly - and Node joins argv into one command line WITHOUT quoting when a shell is
# used. Its docblock states the resulting precondition ("single tokens with no spaces... keep it
# that way") and nothing enforced it, so a step carrying `align ask "why postgres"` shipped and
# broke all three Windows legs: cmd.exe saw `ask why postgres`, Commander bound query="why" and
# silently dropped the rest (it allows excess arguments by default), and the run reported
# "no decisions found" - a wrong answer that looked like a product defect for two rounds.
#
# So the invariant is a check now, not a comment. These run on every platform because the
# argument SHAPE is platform-independent even though the failure only fires on win32.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$SCRIPT_DIR/smoke-timeout.mjs"
FAILURES=0

[ -f "$RUNNER" ] || { echo "FATAL: $RUNNER is missing"; exit 1; }

ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# --- the invariant guard -------------------------------------------------------------------
# An argument containing a space cannot survive the unquoted win32 join, so it must be
# refused everywhere rather than working on two platforms and corrupting on the third.
# The literal argument from the incident, so this fixture cannot drift into something that
# merely looks multi-word. An earlier version of this test used `console.log('x')`, which
# contains no space at all and so could never have exercised the guard.
out=$(node "$RUNNER" 30 echo "why postgres" 2>&1); rc=$?
if [ $rc -eq 2 ] && printf '%s' "$out" | grep -q "space"; then
  ok "refuses an argument containing a space, naming the reason"
else
  bad "a space-bearing argument was accepted (rc=$rc): $out"
fi

# The guard must read the whole argv, not just the first argument.
out=$(node "$RUNNER" 30 echo ok --title "two words" 2>&1); rc=$?
if [ $rc -eq 2 ] && printf '%s' "$out" | grep -q "two words"; then
  ok "refuses a space-bearing argument in any position, quoting the offender"
else
  bad "a later space-bearing argument was accepted (rc=$rc): $out"
fi

# The boundary: ordinary single-token arguments must still run, or the guard is just a ban.
out=$(node "$RUNNER" 30 node --version 2>&1); rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "^v"; then
  ok "runs a command whose arguments are single tokens"
else
  bad "single-token arguments were refused (rc=$rc): $out"
fi

# --- stdin, which the advisory hook needs ---------------------------------------------------
# stdio[0] was hardcoded 'ignore', so feeding a payload meant piping INTO the runner (the
# payload never reached the child) or wrapping in `sh -c "printf ... | align"` - which on win32
# is mangled by the same unquoted join, so `sh` received `printf` as a separate word, printed
# nothing, and align read an empty stdin. Both look identical to a silent hook.
PAYLOAD_FILE="$(mktemp)"
printf '{"hook_event_name":"PreToolUse","tool_input":{"content":"a b c"}}' > "$PAYLOAD_FILE"
out=$(node "$RUNNER" --stdin-file "$PAYLOAD_FILE" 30 node -e "process.stdin.on('data',d=>process.stdout.write(d))" 2>&1); rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q '"hook_event_name"'; then
  ok "--stdin-file delivers the payload to the child"
else
  bad "--stdin-file did not reach the child (rc=$rc): $out"
fi

# Positive control on the assertion above: without the flag the child must see EOF, so a pass
# there cannot be the child inventing the payload from somewhere else.
out=$(node "$RUNNER" 30 node -e "process.stdin.on('data',d=>process.stdout.write(d));process.stdin.on('end',()=>process.stdout.write('EOF'))" 2>&1); rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "EOF" && ! printf '%s' "$out" | grep -q "hook_event_name"; then
  ok "without --stdin-file the child sees an empty stdin"
else
  bad "stdin was not empty by default (rc=$rc): $out"
fi

out=$(node "$RUNNER" --stdin-file /nonexistent/payload.json 30 node --version 2>&1); rc=$?
if [ $rc -eq 2 ] && printf '%s' "$out" | grep -qi "stdin-file"; then
  ok "an unreadable --stdin-file fails loudly instead of running with empty stdin"
else
  bad "a missing --stdin-file was tolerated (rc=$rc): $out"
fi
rm -f "$PAYLOAD_FILE"

# --- pre-existing contract, so this change cannot quietly break it --------------------------
out=$(node "$RUNNER" 1 node -e "setTimeout(()=>{},60000)" 2>&1); rc=$?
if [ $rc -eq 124 ]; then
  ok "a hang still exits 124, distinguishable from a real failure"
else
  bad "timeout did not exit 124 (rc=$rc): $out"
fi

out=$(node "$RUNNER" 30 node -e "process.exit(3)" 2>&1); rc=$?
if [ $rc -eq 3 ]; then
  ok "propagates the child's own exit code"
else
  bad "child exit code not propagated (rc=$rc): $out"
fi

out=$(node "$RUNNER" 30 definitely-not-a-real-binary-xyz 2>&1); rc=$?
if [ $rc -eq 127 ]; then
  ok "a missing binary exits 127"
else
  bad "missing binary did not exit 127 (rc=$rc): $out"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "smoke-timeout guards: all passed"
  exit 0
fi
echo "smoke-timeout guards: $FAILURES failed"
exit 1
