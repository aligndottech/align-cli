import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchConfluenceItems } from '../../lib/fetchers/confluence.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { AuthExpiredError } from '../../lib/errors.js';

interface ConfluenceImportOpts {
  email?: string;
  token?: string;
  domain?: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportConfluenceCommand(importCmd: Command): void {
  importCmd
    .command('confluence')
    .description('Import your Confluence pages')
    .option('--email <email>', 'Atlassian account email (for API token auth)')
    .option('--token <token>', 'Atlassian API token (or uses cached OAuth token from align setup)')
    .option('--domain <domain>', 'Confluence domain, e.g. company.atlassian.net (for API token auth)')
    .option('--limit <n>', 'Max pages to import', '50')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: ConfluenceImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      const token = opts.token ?? config.getConnectorToken(envName, 'confluence');
      const cloudId = !opts.token ? config.getConnectorCloudId(envName, 'confluence') ?? undefined : undefined;
      const siteBase = !opts.token ? config.getConnectorSiteBase(envName, 'confluence') ?? undefined : undefined;

      if (!token) {
        p.log.error('No Confluence credentials found. Run align setup to connect Confluence via OAuth, or pass --email, --token, and --domain.');
        process.exit(1);
      }
      if (!cloudId && (!opts.email || !opts.domain)) {
        p.log.error('OAuth metadata incomplete. Run align setup --reset to reconnect Confluence via OAuth, or pass --email, --token, and --domain.');
        process.exit(1);
      }

      p.intro('align import confluence');
      const spinner = p.spinner();
      spinner.start('Fetching your Confluence pages...');
      try {
        const items = await fetchConfluenceItems({
          token,
          cloudId,
          siteBase,
          email: opts.email,
          domain: opts.domain,
          limit: parseInt(opts.limit, 10),
        });
        spinner.stop(`Found ${items.length} pages`);
        await runPersonalImport(items, client, { label: 'Confluence', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        if (err instanceof AuthExpiredError) {
          p.log.error(err.message);
        } else {
          p.log.error((err as Error).message);
        }
        process.exit(1);
      }
    });
}
