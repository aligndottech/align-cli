import type { Command } from 'commander';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import { subcommandOpts } from '../../lib/command-opts.js';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { NightshiftError, readNightshift } from '../../lib/fetchers/nightshift.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { commandIntro } from '../../lib/brand.js';
import { SYNC_CEILINGS } from '../../lib/import-defaults.js';

interface NightshiftImportOpts {
  dir?: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportNightshiftCommand(importCmd: Command): void {
  importCmd
    .command('nightshift')
    .description("Import the decisions you answered in nightshift's parking lot (open entries stay in nightshift)")
    .option('--dir <path>', 'The repo whose .nightshift folder to read (default: this folder)')
    .option('--limit <n>', 'Max decisions to import', String(SYNC_CEILINGS.nightshift))
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: NightshiftImportOpts, cmd: Command) => {
      const opts = subcommandOpts<NightshiftImportOpts>(cmd);
      const env = createConfigStore().getEnvironment(resolveImportEnv(opts.env));

      p.intro(commandIntro('align connect nightshift'));
      let read;
      try {
        read = await readNightshift(opts.dir ?? process.cwd());
      } catch (e) {
        if (!(e instanceof NightshiftError)) throw e;
        console.error(chalk.red(`align connect nightshift: ${e.message}`));
        process.exit(1);
      }
      if (read.open > 0) p.log.info(`${read.open} parking-lot entr${read.open === 1 ? 'y is' : 'ies are'} still open. Answer ${read.open === 1 ? 'it' : 'them'} in nightshift and run this again.`);
      if (read.items.length === 0) {
        p.log.info(`No answered entries yet in ${read.files} parking-lot file${read.files === 1 ? '' : 's'}.`);
        return;
      }

      const client = createGatewayClient(env);
      try {
        await runPersonalImport(read.items.slice(0, parseInt(opts.limit, 10)), client, {
          label: 'nightshift',
          approve: opts.approve,
          appUrl: resolveAppUrl(env),
          local: env.mode === 'local-embedded',
          funnel: { env, source: 'nightshift' },
        });
      } finally {
        (client as { close?: () => void }).close?.();
      }
    });
}
