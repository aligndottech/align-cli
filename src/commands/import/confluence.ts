import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchConfluenceItems } from '../../lib/fetchers/confluence.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface ConfluenceImportOpts {
  email: string;
  token: string;
  domain: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportConfluenceCommand(importCmd: Command): void {
  importCmd
    .command('confluence')
    .description('Import your Confluence pages (Atlassian API token)')
    .requiredOption('--email <email>', 'Your Atlassian account email')
    .requiredOption('--token <token>', 'Atlassian API token (from id.atlassian.com/manage-profile/security/api-tokens)')
    .requiredOption('--domain <domain>', 'Your Confluence domain (e.g. company.atlassian.net)')
    .option('--limit <n>', 'Max pages to import', '50')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: ConfluenceImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import confluence');
      const spinner = p.spinner();
      spinner.start('Fetching your Confluence pages...');
      try {
        const items = await fetchConfluenceItems({
          email: opts.email,
          token: opts.token,
          domain: opts.domain,
          limit: parseInt(opts.limit, 10),
        });
        spinner.stop(`Found ${items.length} pages`);
        await runPersonalImport(items, client, { label: 'Confluence', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
