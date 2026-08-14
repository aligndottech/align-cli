import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchTeamsItems } from '../../lib/fetchers/teams.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';

interface TeamsImportOpts {
  token?: string;
  personal?: boolean;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportTeamsCommand(importCmd: Command): void {
  importCmd
    .command('teams')
    .description('Import channel messages from Microsoft Teams')
    .option('--token <token>', 'Microsoft Graph API delegated access token')
    .option('--personal', 'Connect via browser OAuth (Align Teams app) instead of pasting a Graph token')
    .option('--limit <n>', 'Max messages to import', '50')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: TeamsImportOpts, cmd: Command) => {
      const opts = subcommandOpts<TeamsImportOpts>(cmd);
      p.log.warn(
        'Requires a delegated Graph API token with ChannelMessage.Read.All scope.\n' +
        '  This permission requires admin consent in most Microsoft 365 tenants.\n' +
        '  Ask your admin to grant consent before running this command.',
      );

      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      let token = opts.token;
      if (!token && opts.personal) {
        try {
          ({ token } = await personalCredsForImport('teams', 'Microsoft Teams', { config, envName, env, client }));
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        p.log.error('No Microsoft Teams credentials. Pass --token, or use --personal to connect via browser OAuth.');
        process.exit(1);
      }

      p.intro('align import teams');
      const spinner = p.spinner();
      spinner.start('Fetching channel messages from Microsoft Teams...');
      try {
        const items = await fetchTeamsItems({
          token,
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
