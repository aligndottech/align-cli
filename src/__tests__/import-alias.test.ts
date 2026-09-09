/**
 * ALI-951: `align import <source>` is an alias of `align connect <source>`. It keeps working,
 * prints ONE deprecation line on stderr per invocation, and goes away two minor releases
 * after the rename - a dated constant this suite reads, so the sunset is enforced by the
 * test rather than remembered.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
vi.mock('../lib/fetchers/jira.js', () => ({
  fetchJiraItems: vi.fn().mockResolvedValue({ items: [{ source_url: 'u', platform: 'jira', raw_text: 't' }], report: { scanned: 1, skips: [] } }),
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

const { registerImportCommand } = await import('../commands/import.js');
const { IMPORT_ALIAS_SUNSET } = await import('../commands/connect.js');
const { fetchJiraItems } = await import('../lib/fetchers/jira.js');
const { runPersonalImport } = await import('../lib/personal-import.js');

async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerImportCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

const deprecationLines = () => stderr.filter((l) => /deprecated/i.test(l));

describe('`align import` is a deprecated alias of `align connect` (ALI-951)', () => {
  beforeEach(() => {
    stderr.length = 0;
    vi.clearAllMocks();
  });

  it('`import git` still runs the git import and prints one line naming `align connect git`', async () => {
    await run(['import', 'git', '--approve']);
    expect(runPersonalImport).toHaveBeenCalledTimes(1);
    expect(deprecationLines()).toHaveLength(1);
    expect(deprecationLines()[0]).toContain('align connect git');
  });

  it('`import jira` does the same, naming `align connect jira`', async () => {
    await run(['import', 'jira', '--email', 'e@x', '--token', 't', '--domain', 'x.atlassian.net', '--approve']);
    expect(fetchJiraItems).toHaveBeenCalledTimes(1);
    expect(deprecationLines()).toHaveLength(1);
    expect(deprecationLines()[0]).toContain('align connect jira');
  });

  it('`connect git` prints no deprecation line (positive control for the two above)', async () => {
    await run(['connect', 'git', '--approve']);
    expect(runPersonalImport).toHaveBeenCalledTimes(1);
    expect(deprecationLines()).toEqual([]);
  });

  it('the alias is removed two minor releases after it was deprecated, and that day has not come', () => {
    const minor = (v: string) => Number(v.split('.')[1]);
    expect(IMPORT_ALIAS_SUNSET.deprecatedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(minor(IMPORT_ALIAS_SUNSET.removeIn)).toBe(minor(IMPORT_ALIAS_SUNSET.deprecatedIn) + 2);
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version: string };
    expect(
      minor(pkg.version) < minor(IMPORT_ALIAS_SUNSET.removeIn),
      `package.json is ${pkg.version}: the \`import\` alias was due for removal in ${IMPORT_ALIAS_SUNSET.removeIn}. Delete the alias, this test, and IMPORT_ALIAS_SUNSET.`,
    ).toBe(true);
  });
});
