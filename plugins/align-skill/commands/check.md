---
description: Check the current changes against the team's recorded decisions with the Align CLI, and report any that conflict.
---

Check the uncommitted changes in this repository against the team's recorded decisions.

1. Run `align --version`. If the command is not found, tell me that the Align CLI is not
   installed and that it lives at github.com/aligndottech/align-cli. Do not install anything.
2. Summarise the change as one sentence that states the decision it makes.
3. Run `align check --all --json --title "<that sentence>"`. `--all` checks staged and unstaged
   changes alike, and `--json` keeps a conflict apart from a check that did not run.
4. Report the result from the exit code:
   - Exit code 0: say that nothing recorded conflicts with the change.
   - Exit code 1: for each entry in `conflicts`, give its `title`, its `reason`, and its `url`
     (or `decision_url`). If the entry in `relevant_decisions` whose `id` matches its
     `decision_id` has `ratified_by` or `decided_at`, say who and when. Then ask me whether to follow the
     decision or keep the change.
   - Exit code 2: say that the check did not run, and show the `message` field. That is not a
     pass.

Do not edit any file while doing this.
