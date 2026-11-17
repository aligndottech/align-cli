---
name: check-decisions
description: Check a planned or finished code change against the team's recorded decisions (ADRs, pull requests, tickets, chat) using the Align CLI. Use before editing code for a task, before committing, before opening a pull request, and when the person asks why something was decided or whether a change is allowed.
---

# Check decisions with Align

Align keeps a record of what this team has decided and where each decision came from. Your job
here is to read that record before you change code, so you do not undo a decision nobody told
you about.

You do this with the `align` command in the terminal. This skill gives you no tools of its own.

## 1. Confirm the CLI is there

Run `align --version`.

- If it prints a version, go on.
- If the command is not found, stop using this skill. Tell the person that the Align CLI is not
  installed and that it lives at github.com/aligndottech/align-cli. Do not install it yourself,
  and do not fetch or run any package to get it.
- If a later command says Align is not set up, tell the person to run `align` once in this
  repository. Do not run setup for them.

## 2. Before you edit: ask what was decided

State the decision you are about to make as one plain sentence with its value, then ask:

`align ask "use paylink-sdk for partial refunds"`

Write the decision, not the chore. "Set the worker pool to 12 connections" finds the right
record. "Wire up a worker" does not.

Read every result. A result that says a later decision replaced it is no longer the rule: follow
the later one.

## 3. After you edit, before you commit: check the change

Run `align check --all --json --title "<the decision in one sentence>"`.

`--all` checks every uncommitted change, staged or not. `--json` prints one JSON result and
keeps a conflict apart from a check that did not run. Read the exit code first:

- Exit code 0: nothing recorded conflicts with the change.
- Exit code 1: a recorded decision conflicts with it. Go to step 4.
- Exit code 2: the check did not run, or ran without a verdict. Say so and show the `message`
  field. A check that did not run is not a pass.

## 4. If a decision conflicts

Stop. Do not edit further and do not commit.

Each entry in the result's `conflicts` list is one decision. Tell the person, for each one:

1. The decision: its `title`.
2. Why your change conflicts with it: its `reason`.
3. The link to where it was made: its `url`, or `decision_url` if there is no `url`.
4. Who made it and when, if the entry in `relevant_decisions` whose `id` matches its
   `decision_id` has `ratified_by` or `decided_at`. If neither is there, leave this out. Do not guess.

Then ask the person which to follow: the recorded decision, or the request as written. If they
choose the request, the decision may be out of date, so say that it should be updated in Align.

Never choose for them, and never work around the conflict quietly.

## 5. When you answer a question about why

When the person asks why something is the way it is, run `align ask` with their question and
answer from what it returns. Give the source link for each decision you cite. If Align returns
nothing, say that no decision is recorded. Do not invent a reason from the code.
