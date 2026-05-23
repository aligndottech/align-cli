import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchNotionItems } from '../../lib/fetchers/notion.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface NotionImportOpts {
  token: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportNotionCommand(importCmd: Command): void {
  importCmd
    .command('notion')
    .description('Import your Notion pages (internal integration token)')
    .requiredOption('--token <token>', 'Notion integration token (secret_...)')
    .option('--limit <n>', 'Max pages to import', '50')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .addHelpText('after', `
Note: Only pages explicitly shared with your Notion integration are visible.
To share a page: open it in Notion → ... menu → Add connections → select your integration.
Create an integration at: notion.so/my-integrations`)
    .action(async (opts: NotionImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import notion');
      p.log.info('Only pages shared with your integration are fetched. See --help for setup instructions.');

      const spinner = p.spinner();
      spinner.start('Fetching your Notion pages...');
      try {
        const items = await fetchNotionItems({ token: opts.token, limit: parseInt(opts.limit, 10) });
        spinner.stop(`Found ${items.length} pages`);
        await runPersonalImport(items, client, { label: 'Notion', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
