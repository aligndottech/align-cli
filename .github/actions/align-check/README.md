# Align Decision Check

Check a pull request against your team's decision graph, and fail the build when it
contradicts a decision someone already made.

Works with Align cloud or a self-hosted gateway. **The check runs entirely from the CLI, so
GitHub Actions is a convenience, not a requirement** - see [Other CI systems](#other-ci-systems).

## GitHub Actions

```yaml
name: Align
on: pull_request

jobs:
  align:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0          # recommended; the action will deepen if you forget
      - uses: aligndottech/align-cli/.github/actions/align-check@main
        with:
          token: ${{ secrets.ALIGN_TOKEN }}
```

### Self-hosted

Point it at your own gateway. Nothing else changes.

```yaml
      - uses: aligndottech/align-cli/.github/actions/align-check@main
        with:
          gateway-url: https://align.internal.example.com
          token: ${{ secrets.ALIGN_TOKEN }}
          tenant-id: ${{ vars.ALIGN_TENANT_ID }}
```

### Inputs

| Input | Default | Purpose |
| -- | -- | -- |
| `token` | - | Align API token. Store as a secret. |
| `tenant-id` | - | Only needed when the token does not identify the tenant. |
| `gateway-url` | Align cloud | Your gateway's base URL, for self-hosting. |
| `env` | `prod` | Align cloud environment, when `gateway-url` is unset. |
| `base-ref` | PR base, else default branch | What to diff against. |
| `fail-on` | `conflict` | `conflict`, `conflict-or-unknown`, or `never`. |
| `cli-version` | `latest` | Version of `@aligndottech/cli` to run. Pin it to an exact version for reproducible builds. |
| `working-directory` | `.` | Directory to run in. |

Outputs: `status` (`aligned` / `conflicting` / `unknown` / `error`) and `result` (the raw JSON).

## What it diffs, and why that matters

The check analyses `git diff <base>...HEAD` - three dots, so it starts from the **merge base**
and contains only the commits on your branch. Two dots would also sweep in everything that
landed on the base since you branched, which means a long-lived branch could be failed by a
conflict it did not introduce.

This is also why a base ref is mandatory in CI. A CI checkout has a clean working tree, so
`git diff` and `git diff --staged` are both empty: a pipeline that runs `align check` without
a base checks nothing and passes every time. The action always passes `--base`.

## Exit codes and `fail-on`

The CLI distinguishes four outcomes, and the distinction is the point:

| Exit | Status | Meaning |
| -- | -- | -- |
| `0` | `aligned` | Checked, related decisions found, none oppose the diff. |
| `0` | `no-context` | Checked, no related decisions found. A result, not a failure. |
| `1` | `conflicting` | Checked, conflicts with a recorded decision. |
| `2` | `unknown` | **Could not check.** Not a pass. |

`no-context` and `unknown` are the pair most easily confused, and folding them together is a
real defect rather than a wording nit: `no-context` means the check ran and the graph had
nothing to say, which is the ordinary outcome for new work. `unknown` means it did not run.
Treating the first as the second made `conflict-or-unknown` block every PR whose diff had no
related decisions, in a repo where that check was required (align-stack#1482).

A conflict is only ever reported when the CLI actually says `conflicting`. If it crashes -
an old version, a bad flag, a runtime error - it also exits `1`, but with no result to
parse, and the action treats that as **could not check**, never as a finding. Reporting a
crash as a conflict would be inventing a result.

`fail-on: conflict` (the default) fails only on a real conflict, and warns when the check
did not complete. That is deliberate: a required status check that fails when the service is
unreachable turns every outage into a repository-wide merge freeze. If you would rather
block than merge unchecked, use `fail-on: conflict-or-unknown`.

The policy is a small script, `decide.sh`, covered by a truth table in
`src/__tests__/action-decide.test.ts`.

Set `fail-on: never` to report into the job summary without ever failing - a good way to
watch the signal before you make the check required.

## Making it a required check

Add the job, let it run on a few PRs, and only then mark it required in your branch
protection ruleset. A required check that has never reported blocks every pull request
indefinitely, because GitHub has no timeout for a status that never arrives.

## Requirements

`--base` ships in the first `@aligndottech/cli` release after `0.8.1`, which is why
`cli-version` defaults to `latest`. Pin it to an exact version once that release is
published.

## Other CI systems

The action is a thin wrapper. Any CI that can run Node can run the check directly:

```bash
npx @aligndottech/cli check --ci --base "origin/$CI_TARGET_BRANCH"
```

Configure it with environment variables:

| Variable | Purpose |
| -- | -- |
| `ALIGN_TOKEN` | API token |
| `ALIGN_TENANT_ID` | Tenant, when the token does not imply one |
| `ALIGN_GATEWAY_URL` | Self-hosted gateway base URL |
| `ALIGN_ENV` | `prod`, `preview` or `local` for Align cloud |

GitLab CI:

```yaml
align:
  image: node:22
  script:
    - git fetch --no-tags origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - npx @aligndottech/cli check --ci --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
  variables:
    ALIGN_TOKEN: $ALIGN_TOKEN
```

The command prints one line of JSON to stdout, so any runner can branch on the exit code or
parse the result.
