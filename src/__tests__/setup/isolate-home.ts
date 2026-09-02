import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Point every home-directory variable the CLI resolves paths from at a throwaway
 * directory, for the whole suite.
 *
 * Without this the unit tests are not hermetic, and not in a theoretical way:
 * `createConfigStore()` runs `migrateConfigDirectory()` and `getLocalDbPath()` runs
 * `migrateLocalDbDirectory()`, both before any mock can intervene, because both resolve
 * their directories through `env-paths` and hit the real filesystem. Measured on a fake
 * home seeded like a real pre-upgrade machine, `npm test` copied BOTH the user's
 * `config.json` and their `local.db` into the new location. Running a test suite is not
 * supposed to migrate the developer's own decision graph.
 *
 * The alternative - having the migrations check NODE_ENV and skip themselves - was
 * rejected. It puts a branch in production code that no production run ever takes, and it
 * switches off precisely the code most worth exercising, so the suite would stop covering
 * the migration it exists to pin. Isolating the environment instead leaves the production
 * path branch-free and still exercised, and it fixes `conf` too: any test that does not
 * mock it writes a real file otherwise.
 *
 * This generalises what setup-local-non-tty.test.ts already does for its subprocess
 * ("HOME is isolated so the run cannot touch the [developer's config]") to the in-process
 * tests, which had no equivalent.
 *
 * Every variable below is one env-paths or os.homedir() actually reads: HOME (POSIX
 * homedir), USERPROFILE (Windows homedir), and the XDG/APPDATA pair env-paths consults
 * per platform. Missing one leaves a platform unisolated, and it would be the platform
 * nobody runs the suite on locally.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-test-home-'));

for (const [key, value] of Object.entries({
  HOME: root,
  USERPROFILE: root,
  XDG_CONFIG_HOME: path.join(root, '.config'),
  XDG_DATA_HOME: path.join(root, '.local', 'share'),
  XDG_CACHE_HOME: path.join(root, '.cache'),
  XDG_STATE_HOME: path.join(root, '.local', 'state'),
  APPDATA: path.join(root, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
})) {
  process.env[key] = value;
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
