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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_TS = join(ROOT, 'src', 'cli.ts');

/**
 * A throwaway Commander command whose action prints the ONE thing this test cares about -
 * `GROQ_API_KEY` after cli.ts's real `preAction` hook has run - then exits. No existing CLI
 * command surfaces this, and adding one permanently for a single test would be a bigger
 * surface than borrowing `buildProgram` for a few lines.
 */
function probeScript(): string {
  return [
    `import { buildProgram } from ${JSON.stringify(CLI_TS)};`,
    `const program = buildProgram({ exitOverride: true });`,
    `program.command('__hydration-probe').action(() => {`,
    `  process.stdout.write(JSON.stringify({ groq: process.env.GROQ_API_KEY ?? null }));`,
    `});`,
    `await program.parseAsync(['node', 'align', '__hydration-probe']);`,
  ].join('\n');
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
    } as unknown as Record<string, string>,
  };
}

describe('startup provider-key hydration actually fires end to end', () => {
  it('a Groq key saved in a previous run reaches process.env before a real command action runs', async () => {
    const { home, env } = makeIsolatedHome();
    try {
      // Written where Conf itself would write it on Linux/macOS - suffix-free, matching
      // config.ts's own projectSuffix: ''. Windows resolves a different subdirectory, so
      // this half of the test is Linux/macOS-only; startup-migration.test.ts's own
      // DIVERGES guard is the precedent for platform-scoping a real-filesystem test.
      const configDir = join(home, '.config', 'align-cli');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ providerKeys: { groq: 'gsk_from_a_previous_run' } }),
      );
      const probePath = join(home, 'probe.mts');
      writeFileSync(probePath, probeScript());

      const { stdout } = await exec(process.execPath, [TSX, probePath], { env, timeout: 30_000 });

      expect(JSON.parse(stdout)).toEqual({ groq: 'gsk_from_a_previous_run' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('a real exported GROQ_API_KEY is left untouched, never overwritten by a stale stored value', async () => {
    const { home, env } = makeIsolatedHome();
    env['GROQ_API_KEY'] = 'gsk_the_real_one_i_just_exported';
    try {
      const configDir = join(home, '.config', 'align-cli');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ providerKeys: { groq: 'gsk_stale_from_storage' } }),
      );
      const probePath = join(home, 'probe.mts');
      writeFileSync(probePath, probeScript());

      const { stdout } = await exec(process.execPath, [TSX, probePath], { env, timeout: 30_000 });

      expect(JSON.parse(stdout)).toEqual({ groq: 'gsk_the_real_one_i_just_exported' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
