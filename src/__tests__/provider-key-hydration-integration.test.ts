/**
 * ALI-1284 (Copilot review, PR #322): every other test of hydrateProviderKeyEnv calls it
 * directly (config.test.ts) or mocks `../lib/config.js` entirely (setup.test.ts) - neither
 * exercises the actual wiring in src/cli.ts's `preAction` hook. A regression that deleted
 * that hook call (or pointed it at the wrong config store) would leave every existing test
 * green while a stored key silently stopped reaching `align ask` on later invocations.
 *
 * CRITICAL, read before touching this file (Copilot review, PR #323, high severity): an
 * earlier version of this test mutated `process.env.HOME` inside the SAME process running
 * the test, hoping that would isolate Conf's on-disk path. It does not. `env-paths` 3.0.0
 * captures `os.homedir()` in a MODULE-LEVEL constant, evaluated once when the module first
 * loads - changing `process.env.HOME` afterward does nothing to it, and `vi.resetModules()`
 * plus a dynamic re-import did not reliably force a fresh read either (observed: the second
 * of two tests in this file still resolved the FIRST test's stale temp path). That version
 * ran locally and overwrote the real `~/.config/align-cli/config.json` on the machine that
 * ran it - confirmed by inspecting the file's content and mtime afterward. It was restored
 * from the untouched legacy `~/.config/align-cli-nodejs/config.json` copy
 * (migrateConfigDirectory never deletes the old file on migration), but anything written to
 * the suffix-free file alone in between was not recoverable.
 *
 * So this test NEVER touches this process's own `process.env` or module cache. It spawns
 * the real CLI entry point as a genuinely separate OS process (the same pattern
 * startup-migration.test.ts already uses for exactly this reason), with `env` passed only
 * to that child's `execFile` call - which cannot affect, and is not affected by, anything
 * cached in this test runner's own process. Observing `process.env.GROQ_API_KEY` from
 * inside a real Commander action needs a probe command no existing CLI command provides,
 * so one is written to a temp file and executed by the same tsx/entry-point mechanism
 * startup-migration.test.ts uses, importing the real `cli.ts` by an explicit path.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
// A `file://` URL, not a raw filesystem path (Copilot review, PR #323, high severity): on
// Windows a bare `C:\...` path is parsed by Node ESM as a URL with scheme `c:`, which it
// rejects outright - the generated import below would fail before the test's own
// assertion ever ran.
const CLI_TS_URL = pathToFileURL(join(ROOT, 'src', 'cli.ts')).href;
const LOCAL_LLM_URL = pathToFileURL(join(ROOT, 'src', 'lib', 'local-llm.ts')).href;

/**
 * A throwaway Commander command whose action prints the ONE thing this test cares about -
 * `GROQ_API_KEY` after cli.ts's real `preAction` hook has run - then exits. No existing CLI
 * command surfaces this, and adding one permanently for a single test would be a bigger
 * surface than borrowing `buildProgram` for a few lines.
 */
function probeScript(): string {
  return [
    `import { buildProgram } from ${JSON.stringify(CLI_TS_URL)};`,
    `import { listConfiguredCredentials } from ${JSON.stringify(LOCAL_LLM_URL)};`,
    `const program = buildProgram({ exitOverride: true });`,
    `program.command('__hydration-probe').action(() => {`,
    `  process.stdout.write(JSON.stringify({ groq: process.env.GROQ_API_KEY ?? null, seen: listConfiguredCredentials() }));`,
    `});`,
    `await program.parseAsync(['node', 'align', '__hydration-probe']);`,
  ].join('\n');
}

/**
 * The exact directory `env-paths` (env-paths 3.0.0, suffix: '' per config.ts) would resolve
 * to for `home`, re-derived from its published algorithm rather than calling the real
 * `envPaths()` here - which would read ITS OWN frozen `os.homedir()`, not this `home`
 * parameter (Copilot review, PR #323, high severity: the first version of this test
 * hardcoded the Linux form and would silently assert against the wrong path on darwin/win32).
 */
function expectedConfigDir(home: string, platform: typeof process.platform): string {
  const name = 'align-cli';
  if (platform === 'darwin') return join(home, 'Library', 'Preferences', name);
  if (platform === 'win32') return join(home, 'AppData', 'Roaming', name, 'Config');
  return join(home, '.config', name); // linux and other XDG-following POSIX platforms
}

function makeIsolatedHome() {
  const home = mkdtempSync(join(tmpdir(), 'align-hydration-home-'));
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: undefined,
      APPDATA: undefined,
      LOCALAPPDATA: undefined,
      GROQ_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      // The child runs the REAL buildProgram(), install-beacon preAction hook included -
      // without this, a fresh isolated store with no opt-out sends a real POST to the
      // hosted telemetry endpoint on every test run (Copilot review, PR #323, "previously
      // missed"). DO_NOT_TRACK is the one usage-telemetry.ts checks before any network call.
      DO_NOT_TRACK: '1',
    } as unknown as Record<string, string>,
  };
}

// H1: saved keys used to be hydrated into process.env here, and every child process inherited
// them - including the coding agent bare `align` opens. They are now read inside local-llm
// through the source cli.ts installs, and process.env is never written.
describe('a saved key reaches align\'s own LLM calls end to end, and never process.env', () => {
  it('a Groq key saved in a previous run is visible to local-llm, while process.env stays clean', async () => {
    const { home, env } = makeIsolatedHome();
    try {
      // Written exactly where Conf itself would write it on THIS platform, suffix-free,
      // matching config.ts's own projectSuffix: '' - see expectedConfigDir's own comment.
      const configDir = expectedConfigDir(home, process.platform);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ providerKeys: { groq: 'gsk_from_a_previous_run' } }),
      );
      const probePath = join(home, 'probe.mts');
      writeFileSync(probePath, probeScript());

      const { stdout } = await exec(process.execPath, [TSX, probePath], { env, timeout: 30_000 });

      expect(JSON.parse(stdout)).toEqual({ groq: null, seen: [{ id: 'groq', source: 'saved' }] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('a real exported GROQ_API_KEY is left untouched, never overwritten by a stale stored value', async () => {
    const { home, env } = makeIsolatedHome();
    env['GROQ_API_KEY'] = 'gsk_the_real_one_i_just_exported';
    try {
      const configDir = expectedConfigDir(home, process.platform);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ providerKeys: { groq: 'gsk_stale_from_storage' } }),
      );
      const probePath = join(home, 'probe.mts');
      writeFileSync(probePath, probeScript());

      const { stdout } = await exec(process.execPath, [TSX, probePath], { env, timeout: 30_000 });

      expect(JSON.parse(stdout)).toEqual({ groq: 'gsk_the_real_one_i_just_exported', seen: [{ id: 'groq', source: 'env' }] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
