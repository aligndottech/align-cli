# Releasing (staged, ALI-797)

The contract: **never test what you didn't ship, never ship what you didn't test.**
Every release is born staged, gets tested as the identical artifacts a user would
receive, and promotion moves those same bytes - one dist-tag, one flag flip, no rebuild.

## The flow

1. **Merge the release-please PR.** That is still the whole trigger. The pipeline then:
   - cuts the GitHub release as a **prerelease** (`releases/latest` keeps serving the
     previous stable - install.sh's default path never sees a staged release),
   - publishes to npm under the **`next`** dist-tag (`npm i -g @aligndottech/cli`
     keeps resolving the previous `latest`),
   - builds and attaches the binaries, exactly as before.
2. **E2E runs automatically** (`e2e-release.yml`) on fresh ubuntu + macos runners:
   the release's own install.sh with `ALIGN_VERSION=<tag>`, checksum verification,
   then the zero-credential golden path (setup, git import with bodies and a promoted
   merge, ask) asserting answer CONTENT and the funnel stages against a local
   telemetry sink. Plus an npm leg installing `@next`.
3. **The human pass** (the machine matrix is necessary, not sufficient):

   ```sh
   ALIGN_VERSION=<tag> curl -fsSL https://align.tech/install.sh | sh
   ```

   on a personal machine, then use it on a real repo. Same bytes the E2E tested.
4. **Promote** - Actions -> "Promote Release" -> run with the tag. It refuses to run
   unless the E2E for that tag is green (`force` is break-glass for a broken harness,
   never for a red one). It then:
   - `npm dist-tag add @aligndottech/cli@<version> latest`
   - flips the GitHub release prerelease -> latest
   - verifies both `latest` pointers moved (effect, not exit codes)
   - publishes to the MCP registry (moved here from the release workflow, so the
     registry always describes the version a stranger actually gets).

## Things that will read as broken and are not

- **A freshly merged release PR shows a prerelease and `npm view` still shows the old
  `latest`.** That is the staging working. Nothing is public until Promote runs.
- **The E2E's asset-wait loops for a few minutes** - the binaries job uploads after
  the release event fires; the wait is the race handled, not a hang.
- **`npm i -g @aligndottech/cli@next` mid-stage gets the release under test.** That is
  the point - it is the tester channel.

## If the E2E is red

Fix forward: the staged release stays a prerelease forever (harmless - nothing
resolves it by default), and the fix lands as the next release-please release, which
stages and tests again. Do not promote a red tag, and do not delete staged releases -
an install line with an explicit `ALIGN_VERSION` may reference them.
