import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchLinearItems } from '../../lib/fetchers/linear.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface LinearImportOpts {
  token: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportLinearCommand(importCmd: Command): void {
  importCmd
    .command('linear')
    .description('Import your Linear issues (personal API token)')
    .requiredOption('--token <token>', 'Linear personal API token (lin_api_...)')
    .option('--limit <n>', 'Max items to import', '100')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: LinearImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import linear');
      const spinner = p.spinner();
      spinner.start('Fetching your Linear issues...');
      try {
        const items = await fetchLinearItems({ token: opts.token, limit: parseInt(opts.limit, 10) });
        spinner.stop(`Found ${items.length} items`);
        await runPersonalImport(items, client, { label: 'Linear', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
