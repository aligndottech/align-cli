---
description: Check the current changes against the team's recorded decisions with the Align CLI, and report any that conflict.
---

Check the uncommitted changes in this repository against the team's recorded decisions.

1. Run `align --version`. If the command is not found, tell me that the Align CLI is not
   installed and that it lives at github.com/aligndottech/align-cli. Do not install anything.
2. Summarise the change as one sentence that states the decision it makes.
3. Run `align check --title "<that sentence>"`.
4. Report the result:
   - Exit code 0: say that nothing recorded conflicts with the change.
   - Exit code 1: for each conflicting decision, give its wording, who made it, when, and the
     link to where it was made. Then ask me whether to follow the decision or keep the change.
   - Anything else: say that the check could not run, and show the error. That is not a pass.

Do not edit any file while doing this.
