import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchSlackItems } from '../../lib/fetchers/slack.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { renderCaptureReport } from '../../lib/capture-report.js';
import { toCaptureSource } from '../../lib/fetchers/capture.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';
import { commandIntro } from '../../lib/brand.js';

interface SlackImportOpts {
  token?: string;
  personal?: boolean;
  limit: string;
  daysBack: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportSlackCommand(importCmd: Command): void {
  importCmd
    .command('slack')
    .description('Import decision threads from Slack (xoxp- user token) [experimental]')
    .option('--token <token>', 'Slack user OAuth token (xoxp-...)')
    .option('--personal', 'Connect your own Slack via browser OAuth (Align personal app) instead of a token')
    .option('--limit <n>', 'Max threads to import', '50')
    .option('--days-back <n>', 'How many days back to scan', '90')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: SlackImportOpts, cmd: Command) => {
      const opts = subcommandOpts<SlackImportOpts>(cmd);
      p.log.warn(chalk.yellow(
        'Experimental: requires a Slack app with xoxp- token installed in your workspace.\n' +
        '  To get a token: api.slack.com/apps → New App → OAuth & Permissions → User Token Scopes:\n' +
        '  channels:read, channels:history, groups:read, groups:history → Install to Workspace\n' +
        '  If workspace blocks self-install, ask your admin to approve the app.',
      ));

      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      let token = opts.token;
      if (!token && opts.personal) {
        try {
          ({ token } = await personalCredsForImport('slack', 'Slack', { config, envName, env, client }));
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        p.log.error('No Slack credentials. Pass --token, or use --personal to connect via browser OAuth.');
        process.exit(1);
      }

      p.intro(commandIntro('align import slack'));
      const spinner = p.spinner();
      spinner.start('Fetching decision threads from Slack...');
      try {
        const fetched = await fetchSlackItems({
          token,
          limit: parseInt(opts.limit, 10),
          daysBack: parseInt(opts.daysBack, 10),
        });
        const { items } = fetched;
        spinner.stop(`Found ${items.length} threads`);
        await runPersonalImport(items, client, { label: 'Slack', approve: opts.approve, appUrl: resolveAppUrl(env), funnel: { env, source: 'slack' } });
        console.log(`${renderCaptureReport([toCaptureSource('Slack', 'threads', fetched)])}\n`);
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
