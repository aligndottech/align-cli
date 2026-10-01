/**
 * ALI-1284 (Copilot review, PR #322): every other test of hydrateProviderKeyEnv calls it
 * directly (config.test.ts) or mocks `../lib/config.js` entirely (setup.test.ts) - neither
 * exercises the actual wiring in src/cli.ts's `preAction` hook. A regression that deleted
 * that hook call (or pointed it at the wrong config store) would leave every existing test
 * green while a stored key silently stopped reaching `align ask` on later invocations.
 *
 * So this one drives the REAL `buildProgram()` tree, with a REAL (file-backed) Conf store
 * pointed at an isolated temp HOME - not the dev machine's actual ~/.config - and observes
 * `process.env` from inside an action Commander actually runs, the same way any registered
 * command's action would see it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import envPaths from 'env-paths';

// Real network/beacon calls have no place in a unit test; cli.ts's OTHER preAction/postAction
// hooks dynamically import this module, so mocking it keeps the install-beacon and
// usage-ping hooks from doing anything observable here.
vi.mock('../lib/usage-telemetry.js', () => ({
  invocationCommandPath: () => 'probe',
  recordInstallBeacon: vi.fn().mockResolvedValue(undefined),
  recordInvocationUsage: vi.fn().mockResolvedValue(undefined),
  envFlagOf: () => undefined,
}));
vi.mock('../commands/default-action.js', () => ({ runDefaultAction: vi.fn() }));

import { buildProgram } from '../cli.js';

describe('startup provider-key hydration actually fires end to end', () => {
  let home: string;
  let configDir: string;
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA', 'GROQ_API_KEY', 'GEMINI_API_KEY']) {
      origEnv[k] = process.env[k];
    }
    home = mkdtempSync(join(tmpdir(), 'align-hydration-home-'));
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    delete process.env['XDG_CONFIG_HOME']; // force the HOME-derived default on every platform
    delete process.env['APPDATA'];
    delete process.env['LOCALAPPDATA'];
    delete process.env['GROQ_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    // The same suffix-free path createConfigStore() itself resolves to (config.ts's own
    // comment on projectSuffix: '') - computed here rather than hardcoded, so this test
    // holds on whatever platform it runs on.
    configDir = envPaths('align-cli', { suffix: '' }).config;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('a Groq key saved in a previous run reaches process.env before a real command action runs', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ providerKeys: { groq: 'gsk_from_a_previous_run' } }),
    );

    let observed: string | undefined;
    const program = buildProgram({ exitOverride: true });
    // A throwaway command rather than a real one (`align ask`, `align env get`) so this
    // test's only dependency is the preAction hook itself, not any other command's own
    // network/filesystem behaviour.
    program.command('__hydration-probe').action(() => {
      observed = process.env['GROQ_API_KEY'];
    });

    await program.parseAsync(['node', 'align', '__hydration-probe']);

    expect(observed).toBe('gsk_from_a_previous_run');
  });

  it('a real exported GROQ_API_KEY is left untouched, never overwritten by a stale stored value', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ providerKeys: { groq: 'gsk_stale_from_storage' } }),
    );
    process.env['GROQ_API_KEY'] = 'gsk_the_real_one_i_just_exported';

    let observed: string | undefined;
    const program = buildProgram({ exitOverride: true });
    program.command('__hydration-probe').action(() => {
      observed = process.env['GROQ_API_KEY'];
    });

    await program.parseAsync(['node', 'align', '__hydration-probe']);

    expect(observed).toBe('gsk_the_real_one_i_just_exported');
  });
});
