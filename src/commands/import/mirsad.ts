import type { Command } from 'commander';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import { subcommandOpts } from '../../lib/command-opts.js';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { MirsadFileError, mirsadUrl, readMirsadFile } from '../../lib/fetchers/mirsad.js';
import { confirmMirsadLinks } from '../../lib/mirsad-links.js';
import { defaultJudge } from '../../lib/curation/judge.js';
import { getLocalDbPath } from '../../lib/local-mode.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { commandIntro } from '../../lib/brand.js';
import { SYNC_CEILINGS } from '../../lib/import-defaults.js';

interface MirsadImportOpts {
  file: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportMirsadCommand(importCmd: Command): void {
  importCmd
    .command('mirsad')
    .description('Import decisions from a MIRSAD JSON export (its supersedes links arrive as confirmed)')
    .requiredOption('--file <path>', 'The MIRSAD JSON export to read')
    .option('--limit <n>', 'Max decisions to import', String(SYNC_CEILINGS.mirsad))
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: MirsadImportOpts, cmd: Command) => {
      const opts = subcommandOpts<MirsadImportOpts>(cmd);
      const env = createConfigStore().getEnvironment(resolveImportEnv(opts.env));

      p.intro(commandIntro('align connect mirsad'));
      let read;
      try {
        read = await readMirsadFile(opts.file);
      } catch (e) {
        if (!(e instanceof MirsadFileError)) throw e;
        console.error(chalk.red(`align connect mirsad: ${e.message}`));
        process.exit(1);
      }
      if (read.skipped > 0) p.log.warn(`Skipped ${read.skipped} item(s) without a numeric id and a title.`);

      const client = createGatewayClient(env);
      const items = read.items.slice(0, parseInt(opts.limit, 10));
      const imported: { stored?: number; failedBatches?: number } = {};
      await runPersonalImport(items, client, {
        label: 'MIRSAD',
        approve: opts.approve,
        appUrl: resolveAppUrl(env),
        local: env.mode === 'local-embedded',
        funnel: { env, source: 'mirsad' },
        result: imported,
      });

      // Only links between decisions of THIS import (after --limit), and only if something was stored.
      const selected = new Set(items.map((i) => i.source_url));
      const links = read.links.filter((l) => selected.has(mirsadUrl(l.newer)) && selected.has(mirsadUrl(l.older)));
      if (links.length === 0 || !imported.stored) return;
      // The confirmed record is a local-graph row (a judgement by this person); a cloud env finds its own links.
      if (env.mode !== 'local-embedded') {
        console.log(chalk.dim('MIRSAD supersedes links are recorded in a local graph only; this environment works out its own.'));
        return;
      }
      const outcome = confirmMirsadLinks(env.localDbPath ?? getLocalDbPath(), links, { judge: await defaultJudge(), terminal: Boolean(process.stdin.isTTY) });
      if (outcome.needsTerminal) {
        console.log(chalk.yellow(`${links.length} supersedes link(s) not recorded: declaring a decision replaced is a person's act, so it needs a terminal. Run this again in your own terminal.`));
        return;
      }
      const tail = [outcome.unmatched ? `${outcome.unmatched} not in your graph` : '', outcome.refused ? `${outcome.refused} refused (the older decision is ratified or confirmed: align mark <newer> replaces <older> --force)` : ''].filter(Boolean);
      console.log(`${outcome.confirmed} supersedes link(s) confirmed, as MIRSAD's owner recorded them${tail.length ? `; ${tail.join('; ')}` : ''}.`);
    });
}
