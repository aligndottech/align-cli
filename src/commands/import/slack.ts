import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchSlackItems } from '../../lib/fetchers/slack.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface SlackImportOpts {
  token: string;
  limit: string;
  daysBack: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportSlackCommand(importCmd: Command): void {
  importCmd
    .command('slack')
    .description('Import decision threads from Slack (xoxp- user token) [experimental]')
    .requiredOption('--token <token>', 'Slack user OAuth token (xoxp-...)')
    .option('--limit <n>', 'Max threads to import', '50')
    .option('--days-back <n>', 'How many days back to scan', '90')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: SlackImportOpts) => {
      p.log.warn(chalk.yellow(
        'Experimental: requires a Slack app with xoxp- token installed in your workspace.\n' +
        '  To get a token: api.slack.com/apps → New App → OAuth & Permissions → User Token Scopes:\n' +
        '  channels:read, channels:history, groups:read, groups:history → Install to Workspace\n' +
        '  If workspace blocks self-install, ask your admin to approve the app.',
      ));

      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import slack');
      const spinner = p.spinner();
      spinner.start('Fetching decision threads from Slack...');
      try {
        const items = await fetchSlackItems({
          token: opts.token,
          limit: parseInt(opts.limit, 10),
          daysBack: parseInt(opts.daysBack, 10),
        });
        spinner.stop(`Found ${items.length} threads`);
        await runPersonalImport(items, client, { label: 'Slack', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
