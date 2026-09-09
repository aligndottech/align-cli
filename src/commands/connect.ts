import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveImportEnv } from '../lib/resolve-env.js';
import { initLocalMode } from '../lib/local-mode.js';
import { createCaptureCollector } from '../lib/capture-report.js';
import { connectLocalSources } from './setup.js';

/**
 * ALI-951: `align import <source>` became `align connect <source>`. The old name stays as
 * an alias for two minor releases, printing one line per invocation, and import-alias.test.ts
 * fails the build the release it is due to go - so the sunset is enforced, not remembered.
 * (oclif's deprecation shape: hide, alias, warn, then remove.)
 */
export const IMPORT_ALIAS_SUNSET = {
  deprecatedIn: '0.38.0',
  deprecatedOn: '2026-09-09',
  removeIn: '0.40.0',
} as const;

/** True when the group was reached through the `import` alias rather than as `connect`. */
export function invokedAsImport(rawArgs: readonly string[]): boolean {
  const verb = rawArgs.find((a) => a === 'import' || a === 'connect');
  return verb === 'import';
}

/** The one stderr line: what to type instead, and when the old spelling stops working. */
export function importAliasLine(subcommand: string | undefined): string {
  const tail = subcommand ? ` ${subcommand}` : '';
  return `align import${tail} is deprecated: use align connect${tail}. The old name is removed in ${IMPORT_ALIAS_SUNSET.removeIn}.`;
}

export interface ConnectOptions {
  source?: string;
  token?: string;
  yes?: boolean;
  json?: boolean;
  env?: EnvName;
}

/**
 * `align connect` with no source: the picker `align setup` uses, against the local graph.
 * Returns false when the resolved env is a cloud one, so the caller can run the cloud
 * connector scan that bare `import` always did there - cloud sources connect by OAuth
 * through `align setup`, and a token pasted here would only ever belong to the local graph.
 */
export async function runConnect(opts: ConnectOptions): Promise<boolean> {
  const envName = resolveImportEnv(opts.env);
  if (envName !== 'local') return false;

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !opts.source) {
    // clig.dev: a non-interactive run with no way to answer the prompt fails, naming the flag.
    console.error(chalk.red('align connect: no terminal to pick a source from. Pass --source <id> (with --token <token> --yes to run with no prompts).'));
    process.exit(2);
  }

  // Copilot review, #283: without --source, an interactive run still opens the multiselect
  // picker - and --token/--json are documented as working WITH --source, but nothing enforced
  // that. A single --token seeds every source the multiselect picks (connectLocalSources
  // applies one seedTokens value to every preselected id), and --json's "one JSON document"
  // contract assumes exactly one source. Both need --source to mean what they say.
  if ((opts.token || opts.json) && !opts.source) {
    const flag = opts.token ? '--token' : '--json';
    console.error(chalk.red(`align connect: ${flag} requires --source <id> - without it, ${opts.token ? '--token would seed every source you pick' : '--json would print one summary per picked source'}.`));
    process.exit(2);
  }

  const config = createConfigStore();
  const { dbPath } = await initLocalMode();
  const localEnv = config.getEnvironment('local');
  const localClient = createGatewayClient(localEnv);
  const capture = createCaptureCollector();

  try {
    const results = await connectLocalSources({
      interactive,
      config,
      localEnv,
      localClient,
      capture,
      approve: opts.yes === true,
      preselected: opts.source ? [opts.source] : undefined,
      seedTokens: opts.token ? { token: opts.token } : undefined,
      json: opts.json,
    });
    if (opts.json) {
      console.log(JSON.stringify({ env: 'local', graph: dbPath, sources: results }));
      return true;
    }
    const captureText = capture.render();
    if (captureText) {
      console.log('');
      console.log(captureText);
    }
    if (results.length === 0 && !opts.source) {
      p.log.info(chalk.dim('Nothing connected. Run align connect again to pick a source, or align connect --source <id>.'));
    }
  } catch (e) {
    console.error(chalk.red(`align connect: ${(e as Error).message}`));
    process.exit(2);
  }
  return true;
}
