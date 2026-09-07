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
3. **The human pass** - optional, no longer a gate (see step 4): still worth doing, since
   it is the only part of this pipeline that runs on a real desktop against a real repo,
   which is exactly what caught the `XDG_CONFIG_HOME` collision documented below.

   ```sh
   ALIGN_VERSION=<tag> curl -fsSL https://align.tech/install.sh | sh
   ```

   on a personal machine, then use it on a real repo. Same bytes the E2E tested.

   **`HOME=<fake> curl ... | sh` alone is not a clean test on a machine that already
   exports an XDG var.** `align`'s config directory resolves through the `env-paths`
   package: `src/lib/local-mode.ts` calls `envPaths('align-cli', { suffix: '' })`
   directly, and `src/lib/config.ts` gets there indirectly - it hands the same
   `projectName`/`projectSuffix` to the `conf` package, which calls `env-paths` with
   those exact arguments internally (`node_modules/conf/dist/source/index.js`). Either
   way, `env-paths` checks `XDG_CONFIG_HOME` before it ever looks at `HOME`, and falls
   back to `$HOME/.config` only when that var is unset. The cache directory is read the
   same way, directly (`process.env['XDG_CACHE_HOME']` in
   `src/lib/local-embeddings-wasm.ts`). So on a desktop that already has
   `XDG_CONFIG_HOME` set - common with a systemd user session, or a line in
   `.bashrc`/`.zshrc` - overriding `HOME` does nothing: `align` still reads and writes
   the real, already-signed-in config at the real `XDG_CONFIG_HOME` path, and the test
   reports a clean first run that never touched a fresh state. This happened on a real
   machine (see ALI-797).

   For a genuinely fresh test, clear the whole environment rather than layering `HOME=`
   on top of it, so there is no `XDG_*` var left for `env-paths` to prefer over the fake
   home - and use a directory that is verifiably new, not a fixed path a previous run
   may have left behind:

   ```sh
   FAKE_HOME="$(mktemp -d)"
   env -i HOME="$FAKE_HOME" PATH="$PATH" ALIGN_INSTALL_DIR="$FAKE_HOME/bin" \
     bash -c 'ALIGN_VERSION=<tag> curl -fsSL https://align.tech/install.sh | sh \
       && "$ALIGN_INSTALL_DIR/align" setup --local'
   ```

   `env -i` drops every inherited variable, `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/
   `XDG_CACHE_HOME` included, so `env-paths` falls back to `$HOME/.config` and
   `align`'s own cache lookup falls back to `$HOME/.cache` - both under `$FAKE_HOME`,
   which `mktemp -d` guarantees did not exist a moment ago. `PATH` has to be passed
   back in explicitly (`env -i` clears that too), or `curl`/`sh` will not resolve.
   `ALIGN_INSTALL_DIR` forces install.sh to put the binary under `$FAKE_HOME/bin`
   rather than its own default (`/usr/local/bin` if writable, else `$HOME/.local/bin`)
   - the outer `$PATH` was captured before the install ran, so it does not contain that
     directory, and without this the `align` on the second line could silently resolve
     to a pre-existing install elsewhere on `$PATH` instead of the one you just staged.
   Invoking `"$ALIGN_INSTALL_DIR/align"` by full path is what makes that guarantee
   land, rather than trusting PATH lookup order. This mirrors the isolation the
   automated E2E already uses - `.github/workflows/e2e-release.yml` sets `HOME` and all
   three `XDG_*` vars explicitly under one fake home, rather than resting on a runner's
   default environment being clean.

4. **Promote runs automatically** when `e2e-release.yml` finishes green for the release
   `release-please` just cut - no action needed. It is scoped to that specific trigger
   (the E2E run's own upstream event must be `release`, not a manual re-run), so re-testing
   an older tag by hand for debugging never auto-promotes it over a newer one already live;
   a second, independent check in the workflow also refuses to move `latest` backwards.
   Manual promotion still works exactly as before - Actions -> "Promote Release" -> run
   with the tag - for a break-glass re-promote or if the automatic run is ever skipped.
   Either way it:
   - refuses to run unless the E2E for that tag is green (`force` is break-glass for a
     broken harness, never for a red one)
   - `npm dist-tag add @aligndottech/cli@<version> latest`
   - flips the GitHub release prerelease -> latest
   - verifies both `latest` pointers moved (effect, not exit codes)
   - publishes to the MCP registry (moved here from the release workflow, so the
     registry always describes the version a stranger actually gets).

   **Automating this step means the human pass above no longer gates what ships** - it
   used to be the second half of "necessary, not sufficient" alongside the E2E matrix.
   Do the human pass whenever you can; it is no longer what unblocks promotion. Added
   after cli-v0.36.0 sat un-promoted on `next` for four days because the manual step was
   simply forgotten - a gap that long meant tags were going untested by a human anyway.

## Things that will read as broken and are not

- **A freshly merged release PR shows a prerelease and `npm view` still shows the old
  `latest`.** That is the staging working - briefly. Promotion follows automatically once
  E2E goes green (usually within a few minutes); nothing is public before that.
- **The E2E's asset-wait loops for a few minutes** - the binaries job uploads after
  the release event fires; the wait is the race handled, not a hang.
- **`npm i -g @aligndottech/cli@next` mid-stage gets the release under test.** That is
  the point - it is the tester channel.

## If the E2E is red

Fix forward: the staged release stays a prerelease forever (harmless - nothing
resolves it by default), and the fix lands as the next release-please release, which
stages and tests again. Do not promote a red tag, and do not delete staged releases -
an install line with an explicit `ALIGN_VERSION` may reference them.
