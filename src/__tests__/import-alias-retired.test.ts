/**
 * ALI-951, the other end of it: `align import` is GONE, and cannot come back by accident.
 *
 * `import-alias.test.ts` enforced the sunset - it failed the build on the release whose version
 * reached `IMPORT_ALIAS_SUNSET.removeIn` (0.40.0), which is exactly what it did on the 0.40.0
 * release PR. Its instruction was "delete the alias, this test, and IMPORT_ALIAS_SUNSET".
 *
 * Deleting it outright would have left the removal unpinned: nothing would fail if someone
 * re-added `.alias('import')`, and a reinstated alias is worse than one never retired, because
 * the deprecation line and its sunset constant are gone now, so it would never expire again.
 * So this file replaces it and asserts the opposite property, in both directions.
 *
 * `import` is still REGISTERED, as a hidden retirement stub that fails with exit 2. That is
 * deliberate and these tests are why: with the command absent, `align`'s default free-text
 * action swallowed `align import git` as a QUESTION and exited 0.
 */
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), step: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCommitHistoryDetailed: vi.fn().mockResolvedValue({ commits: [{ sha: 'abc123', subject: 'feat: a commit' }], scanned: 1, rejectedByRationale: 0 }),
  getRemoteUrl: vi.fn().mockResolvedValue(null),
  buildCommitUrl: vi.fn(() => 'git://commit/abc123'),
  formatCommitAsText: vi.fn(() => 'commit text'),
}));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn(() => 'prod'), resolveImportEnv: vi.fn(() => 'prod') }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 't', mode: 'auth' })),
    getDefaultEnv: vi.fn(() => 'prod'),
    getConnectorToken: vi.fn(() => null),
    getConnectorCloudId: vi.fn(() => null),
    getConnectorSiteBase: vi.fn(() => null),
  })),
}));

const stderr: string[] = [];
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });
vi.spyOn(console, 'log').mockImplementation(() => undefined);

const { registerImportCommand, registerRetiredImportCommand } = await import('../commands/import.js');
const { runPersonalImport } = await import('../lib/personal-import.js');
const connectModule = await import('../commands/connect.js');

async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  // Commander's `.error()` writes through configureOutput.writeErr, NOT console.error, so a
  // no-op writeErr here would swallow the retirement notice and make every assertion on it
  // vacuous - it failed exactly that way on the first run. Both sinks feed one array.
  program.configureOutput({ writeOut() {}, writeErr: (str) => { stderr.push(str); } });
  // Both registrars, because the real CLI registers both through COMMAND_REGISTRY: `connect`
  // is the live group and `import` is the retirement stub. Registering only one would make
  // every assertion here about a tree the CLI never builds.
  registerImportCommand(program);
  registerRetiredImportCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

describe('`align import` was retired in 0.40.0 (ALI-951)', () => {
  beforeEach(() => {
    stderr.length = 0;
    vi.clearAllMocks();
  });

  it('fails `import git` loudly and names `align connect git`', async () => {
    // Exiting NON-ZERO is the whole point, and it is not what deleting the alias gave us.
    // `align` has a default action for a free-text question, so with no `import` command
    // registered at all, `align import git` parsed as the question "import git" and exited 0 -
    // a script that had been importing for a year would keep reporting success and import
    // nothing. Measured on the built binary at the time: exit 0.
    await expect(run(['import', 'git', '--approve'])).rejects.toThrow();
    expect(runPersonalImport).not.toHaveBeenCalled();
    // The message has to carry the replacement, because the person reading it is mid-script.
    const said = stderr.join('\n');
    expect(said).toContain('align connect git');
    expect(said).toContain('removed in 0.40.0');
  });

  it('names the bare replacement for a bare `import`, not a subcommand it never got', async () => {
    // Two examples for the one rule (tdd.md): with a subcommand and without. A single example
    // is satisfied by hardcoding the `git` tail.
    await expect(run(['import'])).rejects.toThrow();
    const said = stderr.join('\n');
    expect(said).toContain('align connect.');
    expect(said).not.toContain('align connect git');
  });

  it('does not answer an unknown option with a parse error instead of the removal notice', async () => {
    // Before the stub took `.allowUnknownOption()`, `align import git --approve` answered
    // "unknown option '--approve'" - true, useless, and naming neither the removal nor the
    // replacement.
    await expect(run(['import', 'git', '--approve'])).rejects.toThrow();
    expect(stderr.join('\n')).not.toContain('unknown option');
  });

  it('still runs `connect git` - the positive control for the rejection above', async () => {
    // Without this, the test above passes against a build where the whole command group is
    // broken, which is a much larger regression wearing the same green.
    await run(['connect', 'git', '--approve']);
    expect(runPersonalImport).toHaveBeenCalledTimes(1);
  });

  it('prints no deprecation line, because there is nothing left to deprecate', async () => {
    await run(['connect', 'git', '--approve']);
    expect(stderr.filter((l) => /deprecated/i.test(l))).toEqual([]);
  });

  it('no longer exports the sunset constant or its helpers', () => {
    // The instruction in the retired test was to delete all three. Asserted rather than
    // trusted: a leftover `invokedAsImport` reads as a live control and cannot fire, which is
    // the dead-code decoy the house rules ask to delete rather than leave for the next reader.
    expect(connectModule).not.toHaveProperty('IMPORT_ALIAS_SUNSET');
    expect(connectModule).not.toHaveProperty('invokedAsImport');
    expect(connectModule).not.toHaveProperty('importAliasLine');
    // Positive control on the module handle: a mistyped import path would satisfy every
    // absence above.
    expect(connectModule).toHaveProperty('runConnect');
  });
});
