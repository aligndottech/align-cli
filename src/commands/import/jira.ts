import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchJiraItems } from '../../lib/fetchers/jira.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { AuthExpiredError } from '../../lib/errors.js';

interface JiraImportOpts {
  email?: string;
  token?: string;
  domain?: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportJiraCommand(importCmd: Command): void {
  importCmd
    .command('jira')
    .description('Import your Jira issues')
    .option('--email <email>', 'Atlassian account email (for API token auth)')
    .option('--token <token>', 'Atlassian API token (or uses cached OAuth token from align setup)')
    .option('--domain <domain>', 'Jira domain, e.g. company.atlassian.net (for API token auth)')
    .option('--limit <n>', 'Max items to import', '100')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: JiraImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      // Resolve auth: explicit flags take priority, then cached OAuth token from align setup
      const token = opts.token ?? config.getConnectorToken(envName, 'jira');
      const cloudId = !opts.token ? config.getConnectorCloudId(envName, 'jira') ?? undefined : undefined;
      const siteBase = !opts.token ? config.getConnectorSiteBase(envName, 'jira') ?? undefined : undefined;

      if (!token) {
        p.log.error('No Jira credentials found. Run align setup to connect Jira via OAuth, or pass --email, --token, and --domain.');
        process.exit(1);
      }
      if (!cloudId && (!opts.email || !opts.domain)) {
        p.log.error('OAuth metadata incomplete. Run align setup --reset to reconnect Jira via OAuth, or pass --email, --token, and --domain.');
        process.exit(1);
      }

      p.intro('align import jira');
      const spinner = p.spinner();
      spinner.start('Fetching your Jira issues...');
      try {
        const items = await fetchJiraItems({
          token,
          cloudId,
          siteBase,
          email: opts.email,
          domain: opts.domain,
          limit: parseInt(opts.limit, 10),
        });
        spinner.stop(`Found ${items.length} items`);
        await runPersonalImport(items, client, { label: 'Jira', approve: opts.approve, appUrl: resolveAppUrl(env) });
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
