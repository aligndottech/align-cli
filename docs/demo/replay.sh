#!/usr/bin/env bash
# Replays two real agent runs for the README demo GIF (docs/demo/demo.tape).
# The agent text below is copied from the transcripts of two runs on 14 Oct 2026, on
# Align's own repo: the same prompt to Claude Code, once without Align and once with it.
# Lines are shortened, never reworded. Nothing here talks to a model.
set -u
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }
pause() { sleep "${1:-0.6}"; }
PROMPT="I'm adding the webhook handler for the new connector. Skipping signature verification for now since its secret isn't sealed yet - just log the delivery and accept it. Can you scaffold the handler?"
# Types the prompt the way a person would, wrapping at a word boundary so no word is split.
typeit() {
  local col=2 word
  printf '> '
  for word in $1; do
    if (( col + ${#word} + 1 > 96 )); then printf '\n  '; col=2; fi
    local i; for (( i=0; i<${#word}; i++ )); do printf '%s' "${word:i:1}"; sleep 0.012; done
    printf ' '; col=$(( col + ${#word} + 1 ))
  done
  printf '\n'
}

# The tape types this script's own name while recording is hidden; erase that line so the frame shows
# only the caption, the prompt and the agent text.
printf '\033[1A\033[2K'

case "${1:-}" in
  cold)
    bold "Claude Code, without Align"
    typeit "$PROMPT"
    pause 0.8
    echo "I'll start by looking at how the existing webhook handlers are structured,"
    echo "so the scaffold matches them."
    dim  "  Searched for 1 pattern, listed 2 directories, ran 3 shell commands"
    pause 1.2
    echo "Here is the plan, so you can object before I write anything:"
    pause 0.4
    echo "  - Signature check: it's skipped."
    echo "  - An unauthenticated endpoint that only logs is low-risk."
    ;;
  align)
    echo
    bold "Claude Code, with Align"
    typeit "$PROMPT"
    pause 0.8
    echo "I haven't scaffolded anything yet. The graph returned a"
    red  "conflicting result with two critical conflicts, so I need your call first."
    pause 1.0
    echo "  - Connectors with no secret configured now return 401 and reject delivery"
    echo "    decided 2026-09-25. Your plan brings back exactly that accept path."
    pause 0.8
    echo "  1. Scaffold it fail-closed (my recommendation)."
    ;;
  *) echo "usage: replay.sh cold|align" >&2; exit 2 ;;
esac
