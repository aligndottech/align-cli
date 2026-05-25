import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchZoomItems } from '../../lib/fetchers/zoom.js';
import { runPersonalImport } from '../../lib/personal-import.js';

interface ZoomImportOpts {
  token: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportZoomCommand(importCmd: Command): void {
  importCmd
    .command('zoom')
    .description('Import cloud recording transcripts from Zoom')
    .requiredOption('--token <token>', 'Zoom OAuth access token')
    .option('--limit <n>', 'Max recordings to import', '30')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (opts: ZoomImportOpts) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro('align import zoom');
      const spinner = p.spinner();
      spinner.start('Fetching cloud recording transcripts from Zoom...');
      try {
        const items = await fetchZoomItems({
          token: opts.token,
          limit: parseInt(opts.limit, 10),
        });
        spinner.stop(`Found ${items.length} recordings with transcripts`);
        await runPersonalImport(items, client, { label: 'Zoom', approve: opts.approve, appUrl: resolveAppUrl(env) });
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
