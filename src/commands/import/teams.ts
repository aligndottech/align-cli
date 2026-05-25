import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchTeamsItems } from '../../lib/fetchers/teams.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface TeamsImportOpts {
  token: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportTeamsCommand(importCmd: Command): void {
  importCmd
    .command('teams')
    .description('Import channel messages from Microsoft Teams')
    .requiredOption('--token <token>', 'Microsoft Graph API delegated access token')
    .option('--limit <n>', 'Max messages to import', '50')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: TeamsImportOpts) => {
      p.log.warn(
        'Requires a delegated Graph API token with ChannelMessage.Read.All scope.\n' +
        '  This permission requires admin consent in most Microsoft 365 tenants.\n' +
        '  Ask your admin to grant consent before running this command.',
      );

      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import teams');
      const spinner = p.spinner();
      spinner.start('Fetching channel messages from Microsoft Teams...');
      try {
        const items = await fetchTeamsItems({
          token: opts.token,
          limit: parseInt(opts.limit, 10),
        });
        spinner.stop(`Found ${items.length} messages`);
        await runPersonalImport(items, client, { label: 'Teams', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
