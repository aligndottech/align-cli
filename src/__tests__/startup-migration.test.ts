/**
 * The ALI-819 directory migrations run from `src/index.ts` at process startup, not from
 * inside `createConfigStore()` / `getLocalDbPath()` - deliberately, so those stay pure and
 * a test that mocks `conf` does not also have to mock the filesystem.
 *
 * The cost of that design is that no unit test can reach the wiring. Measured on
 * `origin/main` before this file existed: deleting BOTH migration calls from src/index.ts
 * left the suite at 1414 passed, identical to baseline. The entire fix could be removed
 * with CI green (ALI-824).
 *
 * So the wiring gets the same treatment setup-local-non-tty.test.ts already uses for its
 * own un-unit-testable property: spawn the real entry point through tsx with an isolated
 * HOME, and assert on what ends up on disk. `--version` is the cheapest invocation that
 * still proves the point, precisely because it does no work - the migration block runs at
 * module scope, above `new Command()`, so it fires before any command is even registered.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = join(ROOT, 'src', 'index.ts');

/**
 * A home where the legacy and current directories genuinely differ, so a migration is
 * observable rather than vacuously satisfied by both names pointing at one directory.
 *
 * On linux that means setting XDG_CONFIG_HOME away from $HOME/.config (the legacy branch
 * hard-codes ~/.config and never read XDG). On win32 it falls out of env-paths nesting
 * config under a `Config` subdirectory the legacy branch never added. On darwin the two
 * agree by construction, so there is nothing to observe and these tests are skipped -
 * legacyLocalDbDir's darwin case is pinned in local-db-directory-migration.test.ts
 * instead.
 */
const DIVERGES = process.platform === 'linux' || process.platform === 'win32';

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'align-startup-home-'));
  const xdg = mkdtempSync(join(tmpdir(), 'align-startup-xdg-'));
  const appData = join(xdg, 'AppData', 'Roaming');

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    APPDATA: appData,
    LOCALAPPDATA: join(xdg, 'AppData', 'Local'),
  };

  // Mirrors legacyLocalDbDir() and env-paths for the platform under test. Written out
  // rather than imported so the test states independently where it expects each side to
  // be: importing legacyLocalDbDir() here would make the assertion agree with the
  // implementation by construction, including when both are wrong.
  const legacyDir =
    process.platform === 'win32' ? join(appData, 'align-cli') : join(home, '.config', 'align-cli');
  const currentDir =
    process.platform === 'win32' ? join(appData, 'align-cli', 'Config') : join(xdg, 'align-cli');
  const legacyConfigDir =
    process.platform === 'win32'
      ? join(appData, 'align-cli-nodejs', 'Config')
      : join(xdg, 'align-cli-nodejs');

  return { home, xdg, env, legacyDir, currentDir, legacyConfigDir };
}

const runCli = (env: Record<string, string | undefined>) =>
  exec(process.execPath, [TSX, ENTRY, '--version'], { env, timeout: 120_000 });

describe.runIf(DIVERGES)('the startup migrations in src/index.ts actually fire', () => {
  it('carries an existing local graph from the legacy directory to the current one', async () => {
    const { env, legacyDir, currentDir } = makeHome();

    // Precondition, asserted rather than assumed: the two directories differ on this
    // platform. Without it a same-path home would make the assertion below pass while
    // nothing migrated at all.
    expect(legacyDir).not.toBe(currentDir);

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(join(legacyDir, 'local.db'), 'decisions-from-before-the-upgrade');
    fs.writeFileSync(join(legacyDir, 'local.db-wal'), 'uncheckpointed-frames');

    await runCli(env);

    expect(fs.readFileSync(join(currentDir, 'local.db'), 'utf8')).toBe(
      'decisions-from-before-the-upgrade',
    );
    // The graph is one logical database across three files; a migration that moves the
    // main file alone drops whatever had not been checkpointed yet.
    expect(fs.readFileSync(join(currentDir, 'local.db-wal'), 'utf8')).toBe(
      'uncheckpointed-frames',
    );
    // The legacy copy is a backup, never consumed.
    expect(fs.existsSync(join(legacyDir, 'local.db'))).toBe(true);
  }, 130_000);

  it('carries an existing config from the old suffixed directory to the current one', async () => {
    const { env, legacyConfigDir, currentDir } = makeHome();

    expect(legacyConfigDir).not.toBe(currentDir);

    fs.mkdirSync(legacyConfigDir, { recursive: true });
    fs.writeFileSync(join(legacyConfigDir, 'config.json'), '{"defaultEnv":"preview"}');

    await runCli(env);

    expect(fs.readFileSync(join(currentDir, 'config.json'), 'utf8')).toBe(
      '{"defaultEnv":"preview"}',
    );
  }, 130_000);

  // Negative control for both tests above. They assert a file EXISTS at the new path, and
  // a CLI that simply created its own config on startup would satisfy that without
  // migrating anything. This proves the files above arrived because they were carried.
  it('invents no graph or config on a genuinely fresh machine', async () => {
    const { env, currentDir } = makeHome();

    await runCli(env);

    expect(fs.existsSync(join(currentDir, 'local.db'))).toBe(false);
    expect(fs.existsSync(join(currentDir, 'config.json'))).toBe(false);
  }, 130_000);
});
