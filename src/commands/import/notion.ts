import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchNotionItems } from '../../lib/fetchers/notion.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';
import { commandIntro } from '../../lib/brand.js';

interface NotionImportOpts {
  token?: string;
  personal?: boolean;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportNotionCommand(importCmd: Command): void {
  importCmd
    .command('notion')
    .description('Import your Notion pages (internal integration token)')
    .option('--token <token>', 'Notion integration token (ntn_...)')
    .option('--personal', 'Connect your own Notion via browser OAuth (Align personal app) instead of a token')
    .option('--limit <n>', 'Max pages to import', '50')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .addHelpText('after', `
Note: Only pages explicitly shared with your Notion integration are visible.
To share a page: open it in Notion → ... menu → Add connections → select your integration.
Create an integration at: https://app.notion.com/developers/tokens`)
    .action(async (_opts: NotionImportOpts, cmd: Command) => {
      const opts = subcommandOpts<NotionImportOpts>(cmd);
      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      let token = opts.token;
      if (!token && opts.personal) {
        try {
          ({ token } = await personalCredsForImport('notion', 'Notion', { config, envName, env, client }));
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        p.log.error('No Notion credentials. Pass --token, or use --personal to connect via browser OAuth.');
        process.exit(1);
      }

      p.intro(commandIntro('align import notion'));
      p.log.info('Only pages shared with your integration are fetched. See --help for setup instructions.');

      const spinner = p.spinner();
      spinner.start('Fetching your Notion pages...');
      try {
        const items = await fetchNotionItems({ token, limit: parseInt(opts.limit, 10) });
        spinner.stop(`Found ${items.length} pages`);
        await runPersonalImport(items, client, { label: 'Notion', approve: opts.approve, appUrl: resolveAppUrl(env), funnel: { env, source: 'notion' } });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
